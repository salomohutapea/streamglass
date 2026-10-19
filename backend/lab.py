"""Bounded request experiments and capture-derived fixtures."""
import base64
import copy
import fnmatch
import math
import uuid
from urllib.parse import urlsplit

from aiohttp import web


def validate_scenarios(value):
    if not isinstance(value, dict) or set(value) != {'rules'} or not isinstance(value['rules'], list) or len(value['rules']) > 100:
        raise ValueError('Expected at most 100 scenario rules')
    ids = set()
    for rule in value['rules']:
        if not isinstance(rule, dict) or set(rule) - {'id', 'name', 'pattern', 'method', 'enabled', 'action', 'eventCount', 'delayMs', 'statusCode'}:
            raise ValueError('Invalid scenario rule')
        for key in ('id', 'name', 'pattern', 'method'):
            if not isinstance(rule.get(key), str) or not rule[key] or len(rule[key]) > 4096:
                raise ValueError(f'Invalid scenario {key}')
        if rule['id'] in ids or type(rule.get('enabled')) is not bool:
            raise ValueError('Scenario ids must be unique and enabled boolean')
        ids.add(rule['id'])
        if rule.get('action') not in ('context-only', 'disconnect-after', 'delay-events', 'http-error-once'):
            raise ValueError('Invalid scenario action')
        for key, default, low, high in (('eventCount', 1, 0, 1000000), ('delayMs', 1000, 0, 60000), ('statusCode', 503, 400, 599)):
            number = rule.get(key, default)
            if type(number) is not int or not low <= number <= high:
                raise ValueError(f'Invalid scenario {key}')
            rule[key] = number
    return copy.deepcopy(value['rules'])


def matching(service, flow):
    if service.bypass_rules(flow):
        return None
    return next((rule for rule in service.scenarios if rule['enabled'] and rule['method'].upper() in ('*', flow.request.method.upper()) and fnmatch.fnmatchcase(flow.request.url, rule['pattern'])), None)


def on_request(service, flow):
    rule = matching(service, flow)
    if not rule:
        return
    flow.metadata['streamglass_scenario'] = copy.deepcopy(rule)
    if rule['action'] == 'http-error-once' and rule['id'] not in service.scenario_used:
        from mitmproxy import http
        service.scenario_used.add(rule['id'])
        flow.metadata['streamglass_map_local'] = 'scenario:' + rule['id']
        flow.response = http.Response.make(rule['statusCode'], b'Streamglass scenario: one-time HTTP error', {'content-type': 'text/plain'})


async def on_event(service, flow, event):
    rule = flow.metadata.get('streamglass_scenario')
    if not rule or service.bypass_rules(flow):
        return True
    action = rule['action']
    if action == 'delay-events' and event.get('event', '').lower() != 'context' and not flow.metadata.get('streamglass_map_local'):
        from .traffic_tools import wait
        await wait(service, flow, rule['delayMs'] / 1000)
    if action == 'disconnect-after':
        if event['sequence'] >= rule['eventCount']:
            flow.metadata['streamglass_disconnect_after_send'] = True
        if event['sequence'] > rule['eventCount']:
            return False
    return action != 'context-only' or event.get('event', '').lower() == 'context'



def make_fixture(record, value):
    if not isinstance(value, dict) or set(value) - {'name', 'timedSse'} or ('timedSse' in value and type(value['timedSse']) is not bool):
        raise ValueError('Expected fixture name and optional timedSse boolean')
    if record.get('kind') == 'tunnel':
        raise ValueError('Encrypted tunnels cannot become response fixtures')
    name = value.get('name', 'Captured response')
    if not isinstance(name, str) or not name.strip() or len(name) > 256:
        raise ValueError('Fixture name must contain 1..256 characters')
    response = record.get('response') or {}
    if record.get('state') != 'complete' or record.get('captureWarning') or (response.get('bodyUnavailable') and not record.get('isSSE')):
        raise ValueError('A fixture requires a complete retained response')
    body = response.get('bodyBase64')
    if not record.get('isSSE') and not isinstance(body, str):
        raise ValueError('The complete response body is unavailable')
    if record.get('isSSE'):
        retained = record.get('events')
        observed = record.get('sseDiagnostics', {}).get('eventCount', record.get('eventCount'))
        if not isinstance(retained, list) or type(observed) is not int or observed != len(retained) or record.get('eventCount') != observed:
            raise ValueError('All observed SSE events must be retained')
        if any(not isinstance(event, dict) or not isinstance(event.get('raw'), str) for event in retained):
            raise ValueError('Complete SSE wire events are unavailable')
        chunks = [base64.b64decode(event['rawBase64'], validate=True) if 'rawBase64' in event else event['raw'].encode() for event in retained if event.get('forwarded', True)]
        body = base64.b64encode(b''.join(chunks)).decode()
    rule = dict(id=str(uuid.uuid4()), name=name.strip(), enabled=False, method=record['method'], pattern=record['url'], statusCode=response['statusCode'], headers=[list(pair) for pair in response['headers'] if pair[0].lower() not in (('content-encoding', 'content-length', 'transfer-encoding') if record.get('isSSE') else ('content-length', 'transfer-encoding'))], bodyBase64=body)
    if value.get('timedSse'):
        events = [event for event in record.get('events', []) if event.get('forwarded', True)]
        if not record.get('isSSE') or not events or len(events) > 10000:
            raise ValueError('Timed fixtures require 1..10000 retained SSE events')
        previous = record.get('sseDiagnostics', {}).get('headersAt', events[0].get('receivedAt', 0))
        delays = []
        for event in events:
            current = event.get('receivedAt')
            if type(current) not in (int, float) or not math.isfinite(current) or type(previous) not in (int, float) or not math.isfinite(previous):
                raise ValueError('This capture has no event timing information')
            gap = max(0, round((current - previous) * 1000))
            if gap > 60000:
                raise ValueError('Recorded event gap exceeds the 60 second fixture limit')
            delays.append(gap)
            previous = current
        rule['eventDelaysMs'] = delays
    return rule


def replay_message(value):
    if not isinstance(value, dict) or set(value) != {'url', 'method', 'headers', 'bodyBase64'}:
        raise ValueError('Send requires explicit url, method, headers, and bodyBase64')
    if not isinstance(value['url'], str) or len(value['url']) > 16384 or not isinstance(value['method'], str) or len(value['method']) > 64 or value['method'].upper() == 'CONNECT':
        raise ValueError('Send requires an HTTP request, not an encrypted tunnel')
    if not isinstance(value['bodyBase64'], str) or len(value['bodyBase64']) > 12 * 1024 * 1024:
        raise ValueError('Request body exceeds 8 MiB')
    raw = base64.b64decode(value['bodyBase64'], validate=True)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError('Request body exceeds 8 MiB')
    from mitmproxy import http
    from .service import apply_message
    message = http.Request.make('GET', 'http://localhost/')
    apply_message(message, value, request=True)
    for name in ('host', ':authority', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade'):
        message.headers.pop(name, None)
    message.headers['Host'] = urlsplit(message.url).netloc
    if urlsplit(message.url).username is not None:
        raise ValueError('Pass authentication explicitly in headers')
    return message


def replay_flow(service, message):
    from mitmproxy import http, connection
    flow = http.HTTPFlow(connection.Client(peername=('127.0.0.1', 0), sockname=('127.0.0.1', service.settings['proxyPort'])), connection.Server(address=(message.host, message.port)))
    flow.request = message
    return flow


def routes(app, service):
    async def scenarios(request):
        if request.method == 'PUT':
            service.scenarios = validate_scenarios(await request.json())
            service.scenario_used.clear()
            service.persist_config()
        return web.json_response({'rules': service.scenarios})

    async def fixture(request):
        record = service.records.get(request.match_info['id'])
        if record is None:
            raise web.HTTPNotFound()
        value = await request.json()
        rule = make_fixture(record, value)
        from .traffic_tools import validate
        tools = validate({**service.traffic_tools, 'mapLocalRules': [*service.traffic_tools['mapLocalRules'], rule]})
        service.traffic_tools = tools
        service.persist_config()
        return web.json_response(rule, status=201)

    async def replay(request):
        if service.master is None:
            raise ValueError('Start the proxy before sending a request')
        flow = replay_flow(service, replay_message(await request.json()))
        service.master.commands.call('replay.client', [flow])
        return web.json_response({'id': flow.id}, status=202)

    app.add_routes([web.get('/api/scenarios', scenarios), web.put('/api/scenarios', scenarios), web.post('/api/records/{id}/fixture', fixture), web.post('/api/replay', replay)])
