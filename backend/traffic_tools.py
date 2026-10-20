"""Validated, profile-local traffic tools; no filesystem paths cross the API."""
import asyncio
import base64
import copy
import fnmatch
import re

from .traffic_rules import RULE_KEYS, normalize, validate_rules

MAX_LOCAL_BODY = 32 * 1024 * 1024
DEFAULT_NETWORK = dict(enabled=False, delayMs=0, downloadKbps=0, uploadKbps=0, hostPattern='*', deviceId='')


def validate(value):
    if not isinstance(value, dict) or not {'mapLocalRules', 'network'} <= set(value) <= {'mapLocalRules', 'network', *RULE_KEYS}:
        raise ValueError('Expected mapLocalRules and network')
    value = normalize(copy.deepcopy(value))
    rules, network = value['mapLocalRules'], value['network']
    if not isinstance(rules, list) or len(rules) > 100:
        raise ValueError('Expected at most 100 Map Local rules')
    ids, total = set(), 0
    for rule in rules:
        if not isinstance(rule, dict) or set(rule) - {'id', 'name', 'enabled', 'method', 'pattern', 'statusCode', 'headers', 'bodyBase64', 'fileName', 'eventDelaysMs'}:
            raise ValueError('Invalid Map Local rule')
        for key, limit in (('id', 128), ('name', 256), ('pattern', 4096), ('method', 128)):
            if not isinstance(rule.get(key), str) or not rule[key] or len(rule[key]) > limit:
                raise ValueError(f'Invalid Map Local {key}')
        if 'fileName' in rule and (not isinstance(rule['fileName'], str) or len(rule['fileName']) > 255):
            raise ValueError('Invalid Map Local fileName')
        if rule['id'] in ids:
            raise ValueError('Map Local ids must be unique')
        ids.add(rule['id'])
        if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", rule['method']):
            raise ValueError('Invalid Map Local method')
        if type(rule.get('enabled')) is not bool or type(rule.get('statusCode')) is not int or not 200 <= rule['statusCode'] <= 599:
            raise ValueError('Invalid Map Local enabled or statusCode')
        delays = rule.get('eventDelaysMs', [])
        if not isinstance(delays, list) or len(delays) > 10000 or any(type(delay) is not int or not 0 <= delay <= 60000 for delay in delays):
            raise ValueError('Invalid timed SSE event delays')
        headers = rule.get('headers')
        if not isinstance(headers, list) or len(headers) > 1000:
            raise ValueError('Invalid Map Local headers')
        for pair in headers:
            if not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(v, str) for v in pair):
                raise ValueError('Invalid Map Local header pair')
            name, text = pair
            if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or any(c in text for c in '\r\n\x00'):
                raise ValueError('Invalid Map Local header')
            text.encode('latin-1')
        body = rule.get('bodyBase64')
        if not isinstance(body, str) or len(body) > (MAX_LOCAL_BODY + 2) // 3 * 4:
            raise ValueError('Map Local body exceeds 32 MiB')
        total += len(base64.b64decode(body, validate=True))
        if total > MAX_LOCAL_BODY:
            raise ValueError('Map Local bodies exceed 32 MiB total')
    validate_rules(value)
    if not isinstance(network, dict) or set(network) != set(DEFAULT_NETWORK):
        raise ValueError('Invalid network profile fields')
    if type(network['enabled']) is not bool:
        raise ValueError('Network enabled must be boolean')
    for key, maximum in (('delayMs', 60000), ('downloadKbps', 10000000), ('uploadKbps', 10000000)):
        if type(network[key]) is not int or not 0 <= network[key] <= maximum:
            raise ValueError(f'{key} must be 0..{maximum}')
    for key, limit in (('hostPattern', 255), ('deviceId', 255)):
        if not isinstance(network[key], str) or len(network[key]) > limit or any(c in network[key] for c in '\r\n\x00'):
            raise ValueError(f'Invalid {key}')
    if not network['hostPattern']:
        raise ValueError('hostPattern must not be empty')
    return copy.deepcopy(value)


def summary(value):
    return {**value, 'mapLocalRules': [{**{k: v for k, v in rule.items() if k != 'bodyBase64'},
                                     'bodySize': len(rule['bodyBase64']) * 3 // 4 - (2 if rule['bodyBase64'].endswith('==') else 1 if rule['bodyBase64'].endswith('=') else 0)} for rule in value['mapLocalRules']]}


def network_for(service, flow):
    network = service.traffic_tools['network']
    if service.bypass_rules(flow) or not network['enabled']:
        return None
    if not fnmatch.fnmatchcase(flow.request.host.lower(), network['hostPattern'].lower()):
        return None
    if network['deviceId'] and network['deviceId'] != str(flow.client_conn.peername[0]):
        return None
    return network


async def wait(service, flow, seconds):
    if seconds <= 0 or service.bypass_rules(flow):
        return
    epoch = service.capture_epoch
    try:
        await asyncio.wait_for(service.capture_pause.wait(), seconds)
    except TimeoutError:
        pass
    if epoch != service.capture_epoch:
        flow.metadata['streamglass_passthrough'] = True


def map_response(service, flow):
    if service.bypass_rules(flow):
        return
    from mitmproxy import http
    for rule in service.traffic_tools['mapLocalRules']:
        if rule['enabled'] and rule['method'].upper() in ('*', flow.request.method.upper()) and fnmatch.fnmatchcase(flow.request.url, rule['pattern']):
            headers = http.Headers([(k.encode('ascii'), v.encode('latin-1')) for k, v in rule['headers']
                                    if k.lower() not in ('content-length', 'transfer-encoding')])
            body = base64.b64decode(rule['bodyBase64'])
            if flow.request.method == 'HEAD' or rule['statusCode'] in (204, 304):
                body = b''
            flow.response = http.Response.make(rule['statusCode'], body, headers)
            flow.metadata['streamglass_map_local'] = rule['id']
            if rule.get('eventDelaysMs'):
                flow.metadata['streamglass_fixture_delays'] = list(rule['eventDelaysMs'])
            return
