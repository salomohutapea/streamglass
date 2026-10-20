"""Map Remote, Rewrite and Block rules. Validation and persistence live in traffic_tools.validate;
these rules reuse the Map Local method/wildcard matcher and never run while capture is paused."""
import fnmatch
import re

MAX_RULES = 100
RULE_KEYS = ('mapRemoteRules', 'rewriteRules', 'blockRules')
RULE_TYPES = {'mapRemoteRules': 'map-remote', 'rewriteRules': 'rewrite', 'blockRules': 'block'}
LABELS = {'mapRemoteRules': 'Map Remote', 'rewriteRules': 'Rewrite', 'blockRules': 'Block'}
TOKEN = r"[!#$%&'*+.^_`|~0-9A-Za-z-]+"
MAX_REWRITE_BODY = 8 * 1024 * 1024
# Framing and routing headers are owned by the proxy, not by rules.
RESERVED_HEADERS = {'host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer'}
COMMON = {'id', 'name', 'enabled', 'method', 'pattern', 'group'}
EXTRA = {'mapRemoteRules': {'scheme', 'host', 'port', 'pathFrom', 'pathTo', 'keepHost', 'headerOps'},
         'rewriteRules': {'phase', 'headerOps', 'statusCode', 'bodyFind', 'bodyReplace'},
         'blockRules': {'action', 'statusCode', 'body'}}


def normalize(value):
    """Older stored configurations predate these lists."""
    for key in RULE_KEYS:
        value.setdefault(key, [])
    return value


def _text(rule, key, limit, label, required=False):
    text = rule.get(key, '')
    if not isinstance(text, str) or len(text) > limit or (required and not text) or any(c in text for c in '\r\n\x00'):
        raise ValueError(f'Invalid {label} {key}')
    return text


def _header_ops(rule, label):
    ops = rule.get('headerOps', [])
    if not isinstance(ops, list) or len(ops) > 50:
        raise ValueError(f'Invalid {label} headerOps')
    for op in ops:
        if not isinstance(op, dict) or set(op) - {'op', 'name', 'value'} or op.get('op') not in ('set', 'remove'):
            raise ValueError(f'Invalid {label} header operation')
        name = op.get('name')
        if not isinstance(name, str) or len(name) > 256 or not re.fullmatch(TOKEN, name) or name.lower() in RESERVED_HEADERS:
            raise ValueError(f'Invalid {label} header name')
        value = op.get('value', '')
        if not isinstance(value, str) or len(value) > 8192 or any(c in value for c in '\r\n\x00'):
            raise ValueError(f'Invalid {label} header value')
        value.encode('latin-1')
        if op['op'] == 'set' and 'value' not in op:
            raise ValueError(f'Invalid {label} header value')


def _path(rule, key, label):
    text = _text(rule, key, 2048, label)
    if text and (not text.startswith('/') or '?' in text or '#' in text or any(ord(c) <= 32 or ord(c) == 127 for c in text)):
        raise ValueError(f'Invalid {label} {key}')


def _status(rule, label, low, high, zero=False):
    code = rule.get('statusCode', 0 if zero else None)
    if type(code) is not int or not ((zero and code == 0) or low <= code <= high):
        raise ValueError(f'Invalid {label} statusCode')
    return code


def validate_rules(value):
    for key in RULE_KEYS:
        rules, label = value[key], LABELS[key]
        if not isinstance(rules, list) or len(rules) > MAX_RULES:
            raise ValueError(f'Expected at most {MAX_RULES} {label} rules')
        ids = set()
        for rule in rules:
            if not isinstance(rule, dict) or set(rule) - COMMON - EXTRA[key]:
                raise ValueError(f'Invalid {label} rule')
            for name, limit in (('id', 128), ('name', 256), ('pattern', 4096), ('method', 128)):
                if not isinstance(rule.get(name), str) or not rule[name] or len(rule[name]) > limit:
                    raise ValueError(f'Invalid {label} {name}')
            if rule['id'] in ids:
                raise ValueError(f'{label} ids must be unique')
            ids.add(rule['id'])
            if not re.fullmatch(TOKEN, rule['method']):
                raise ValueError(f'Invalid {label} method')
            if type(rule.get('enabled')) is not bool:
                raise ValueError(f'Invalid {label} enabled')
            if 'group' in rule:
                _text(rule, 'group', 64, label)
            if key == 'mapRemoteRules':
                if rule.get('scheme') not in ('http', 'https'):
                    raise ValueError('Invalid Map Remote scheme')
                if not isinstance(rule.get('host'), str) or not re.fullmatch(r'(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)', rule['host']) or len(rule['host']) > 253:
                    raise ValueError('Invalid Map Remote host')
                if type(rule.get('port', 0)) is not int or not 0 <= rule.get('port', 0) <= 65535:
                    raise ValueError('Invalid Map Remote port')
                if type(rule.get('keepHost', False)) is not bool:
                    raise ValueError('Invalid Map Remote keepHost')
                _path(rule, 'pathFrom', label)
                _path(rule, 'pathTo', label)
                if rule.get('pathTo') and not rule.get('pathFrom'):
                    raise ValueError('Map Remote pathTo requires pathFrom')
                _header_ops(rule, label)
            elif key == 'rewriteRules':
                if rule.get('phase') not in ('request', 'response'):
                    raise ValueError('Invalid Rewrite phase')
                _header_ops(rule, label)
                find, replace = _text_body(rule, 'bodyFind', 4096), _text_body(rule, 'bodyReplace', 65536)
                code = _status(rule, label, 200, 599, zero=True)
                if rule['phase'] == 'request' and (code or find or replace):
                    raise ValueError('Request Rewrite rules support header operations only')
                if replace and not find:
                    raise ValueError('Rewrite bodyReplace requires bodyFind')
                if not rule.get('headerOps') and not code and not find:
                    raise ValueError('Rewrite rule changes nothing')
            else:
                if rule.get('action') not in ('respond', 'close'):
                    raise ValueError('Invalid Block action')
                _status(rule, label, 400, 599)
                body = rule.get('body', '')
                if not isinstance(body, str) or len(body) > 4096:
                    raise ValueError('Invalid Block body')
    return value


def _text_body(rule, key, limit):
    text = rule.get(key, '')
    if not isinstance(text, str) or len(text) > limit or '\x00' in text:
        raise ValueError(f'Invalid Rewrite {key}')
    return text


def rules_active(tools):
    return any(rule['enabled'] for key in RULE_KEYS for rule in tools.get(key, []))


def matches(rule, flow):
    return rule['enabled'] and rule['method'].upper() in ('*', flow.request.method.upper()) and fnmatch.fnmatchcase(flow.metadata.get('streamglass_rule_url') or flow.request.url, rule['pattern'])


def _first(service, flow, key):
    return next((rule for rule in service.traffic_tools.get(key, []) if matches(rule, flow)), None)


def needs_request_buffer(service, flow):
    """Block rules answer without upstream, so their request body must be bounded before matching."""
    return not service.bypass_rules(flow) and _first(service, flow, 'blockRules') is not None


def note(flow, key, rule, detail=''):
    entry = {'type': RULE_TYPES[key], 'id': rule['id'], 'name': rule['name']}
    if detail:
        entry['detail'] = detail
    flow.metadata.setdefault('streamglass_applied_rules', []).append(entry)


def _apply_ops(headers, ops):
    for op in ops:
        if op['op'] == 'remove':
            headers.pop(op['name'], None)
        else:
            headers[op['name']] = op['value']


def block_request(service, flow):
    """Returns 'respond', 'close' or None. A synthetic response never reaches the origin."""
    if service.bypass_rules(flow):
        return None
    rule = _first(service, flow, 'blockRules')
    if rule is None:
        return None
    note(flow, 'blockRules', rule, f"{rule['statusCode']}" if rule['action'] == 'respond' else 'connection closed')
    if rule['action'] == 'close':
        return 'close'
    from mitmproxy import http
    body = rule.get('body', '').encode('utf-8')
    if flow.request.method == 'HEAD':
        body = b''
    flow.response = http.Response.make(rule['statusCode'], body, {'content-type': 'text/plain; charset=utf-8'})
    flow.metadata['streamglass_map_local'] = 'block:' + rule['id']
    return 'respond'


def _remap_path(path, rule):
    source = rule.get('pathFrom', '')
    if not source:
        return path
    base, separator, query = path.partition('?')
    prefix = source.rstrip('/')
    if prefix and base != prefix and not base.startswith(prefix + '/'):
        return path
    new = rule.get('pathTo', '').rstrip('/') + base[len(prefix):] or '/'
    return new + separator + query


def map_remote(service, flow):
    if service.bypass_rules(flow):
        return None
    rule = _first(service, flow, 'mapRemoteRules')
    if rule is None:
        return None
    request = flow.request
    original = request.url
    flow.metadata['streamglass_rule_url'] = original  # later rules and the response phase match what the client asked for
    original_host = request.host_header
    request.path = _remap_path(request.path, rule)
    request.scheme = rule['scheme']
    request.host = rule['host'].strip('[]')
    request.port = rule.get('port') or (443 if rule['scheme'] == 'https' else 80)
    if rule.get('keepHost', False):
        request.host_header = original_host
    _apply_ops(request.headers, rule.get('headerOps', []))
    note(flow, 'mapRemoteRules', rule, f"{original} -> {request.url}")
    return rule


def rewrite_request(service, flow):
    if service.bypass_rules(flow):
        return
    for rule in service.traffic_tools.get('rewriteRules', []):
        if rule['phase'] == 'request' and matches(rule, flow):
            _apply_ops(flow.request.headers, rule.get('headerOps', []))
            note(flow, 'rewriteRules', rule, 'request headers')


def _response_rules(service, flow):
    if service.bypass_rules(flow) or flow.response is None or flow.metadata.get('streamglass_map_local'):
        return []
    return [rule for rule in service.traffic_tools.get('rewriteRules', []) if rule['phase'] == 'response' and matches(rule, flow)]


def rewrite_response_headers(service, flow):
    """Headers and status are safe to change on any response, including streamed and SSE ones."""
    if flow.metadata.get('streamglass_rewrite_headers_done'):
        return
    flow.metadata['streamglass_rewrite_headers_done'] = True
    for rule in _response_rules(service, flow):
        _apply_ops(flow.response.headers, rule.get('headerOps', []))
        if rule.get('statusCode'):
            flow.response.status_code = rule['statusCode']
        if rule.get('headerOps') or rule.get('statusCode'):
            note(flow, 'rewriteRules', rule, 'response headers/status')
    _sync(service, flow)


def rewrite_response_body(service, flow):
    """Text find/replace only for complete, buffered, UTF-8 non-SSE bodies within the bound; others are forwarded untouched."""
    for rule in _response_rules(service, flow):
        find = rule.get('bodyFind', '')
        if not find:
            continue
        skipped = None
        response = flow.response
        if response.stream or flow.id in service.streams or response.raw_content is None:
            skipped = 'streamed body not rewritten'
        elif 'text/event-stream' in response.headers.get('content-type', '').lower():
            skipped = 'SSE body not rewritten'
        elif len(response.raw_content) > MAX_REWRITE_BODY:
            skipped = 'body over 8 MiB not rewritten'
        else:
            try:
                text = response.content.decode('utf-8')
            except (ValueError, UnicodeDecodeError):
                skipped = 'non-UTF-8 body not rewritten'
        if skipped is None:
            count = text.count(find)
            if count:
                response.content = text.replace(find, rule.get('bodyReplace', '')).encode('utf-8')
                note(flow, 'rewriteRules', rule, f'body: {count} replacement{"s" if count != 1 else ""}')
            continue
        note(flow, 'rewriteRules', rule, skipped)
    _sync(service, flow)


def _sync(service, flow):
    record = service.records.get(flow.id)
    if record is not None and flow.metadata.get('streamglass_applied_rules'):
        record['appliedRules'] = list(flow.metadata['streamglass_applied_rules'])
