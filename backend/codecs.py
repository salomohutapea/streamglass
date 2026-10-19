"""Opt-in local body codecs. Keys and decoded bodies never enter capture storage."""
import base64
import binascii
import copy
import fnmatch
import gzip
import os
import zlib

from aiohttp import web
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

LIMIT = 4 * 1024 * 1024
FIELDS = {'id', 'name', 'enabled', 'pattern', 'bundleId', 'kind', 'compression', 'keyFormat', 'decodeSource', 'encodeSource', 'allowEditing'}


def validate_profiles(value):
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError('Expected at most 100 codecs')
    result, ids = [], set()
    for raw in value:
        if not isinstance(raw, dict) or set(raw) - FIELDS:
            raise ValueError('Unknown codec field; keys must use the session key endpoint')
        p = copy.deepcopy(raw)
        for key in ('id', 'name', 'pattern'):
            if not isinstance(p.get(key), str) or not p[key] or len(p[key]) > 4096:
                raise ValueError('Invalid codec ' + key)
        if p['id'] in ids:
            raise ValueError('Duplicate codec id')
        ids.add(p['id'])
        if p.get('kind') not in ('base64', 'aes-cbc', 'aes-ctr', 'custom-js') or p.get('compression', 'none') not in ('none', 'gzip') or p.get('keyFormat', 'base64') not in ('base64', 'native64'):
            raise ValueError('Invalid codec format')
        for key in ('enabled', 'allowEditing'):
            if type(p.get(key, False)) is not bool:
                raise ValueError('Invalid codec ' + key)
            p.setdefault(key, False)
        for key in ('bundleId', 'decodeSource', 'encodeSource'):
            if key in p and (not isinstance(p[key], str) or len(p[key]) > 100000):
                raise ValueError('Invalid codec ' + key)
        result.append(p)
    return result


def bounded(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > LIMIT:
        raise ValueError('Codec body must be text under 4 MiB')
    return text


def key_bytes(profile, supplied):
    if not isinstance(supplied, str):
        raise ValueError('Set a session key for this codec')
    if profile.get('keyFormat') == 'native64':
        if len(supplied) != 64 or not supplied.isascii():
            raise ValueError('Native key must contain 64 ASCII characters')
        return (supplied[52:56] + supplied[3:7] + supplied[10:14] + supplied[17:21]).encode()
    try:
        key = base64.b64decode(supplied, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError('Key must be valid base64') from None
    if len(key) not in (16, 24, 32):
        raise ValueError('AES key must contain 16, 24 or 32 bytes')
    return key


def transform(profile, text, key=None, encode=False):
    bounded(text)
    try:
        if encode:
            data = text.encode()
            if profile.get('compression') == 'gzip':
                data = gzip.compress(data)
            if profile['kind'].startswith('aes-'):
                iv = os.urandom(16)
                if profile['kind'] == 'aes-cbc':
                    padder = padding.PKCS7(128).padder()
                    data = padder.update(data) + padder.finalize()
                cryptor = Cipher(algorithms.AES(key), modes.CBC(iv) if profile['kind'] == 'aes-cbc' else modes.CTR(iv)).encryptor()
                data = iv + cryptor.update(data) + cryptor.finalize()
            return bounded(base64.b64encode(data).decode())
        data = base64.b64decode(text, validate=True)
        if profile['kind'].startswith('aes-'):
            if len(data) < 16:
                raise ValueError('Missing IV')
            iv, data = data[:16], data[16:]
            cryptor = Cipher(algorithms.AES(key), modes.CBC(iv) if profile['kind'] == 'aes-cbc' else modes.CTR(iv)).decryptor()
            data = cryptor.update(data) + cryptor.finalize()
            if profile['kind'] == 'aes-cbc':
                unpadder = padding.PKCS7(128).unpadder()
                data = unpadder.update(data) + unpadder.finalize()
        if profile.get('compression') == 'gzip':
            decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
            data = decoder.decompress(data, LIMIT + 1)
            if len(data) > LIMIT or not decoder.eof or decoder.unused_data:
                raise ValueError('Invalid or oversized gzip body')
        return bounded(data.decode('utf-8'))
    except (ValueError, UnicodeError, binascii.Error, zlib.error):
        raise ValueError('Codec failed: check key, format, compression and complete body') from None


def select(service, url, value, codec_id=None):
    if value.get('bodyUnavailable') or value.get('bodyTruncated'):
        raise ValueError('Complete body is required for decoding')
    headers = {name.lower(): val for name, val in value.get('headers', [])}
    profile = next((p for p in service.codecs if p['enabled'] and (not codec_id or p['id'] == codec_id) and fnmatch.fnmatchcase(url, p['pattern']) and (not p.get('bundleId') or headers.get('x-bundle-id') == p['bundleId'])), None)
    if not profile:
        raise ValueError('No enabled codec matches this response')
    return profile


async def convert(service, profile, text, value, url, encode=False, request_context=None):
    if profile['kind'] != 'custom-js':
        key = key_bytes(profile, service.codec_keys.get(profile['id'])) if profile['kind'].startswith('aes-') else None
        return transform(profile, text, key, encode)
    source = profile.get('encodeSource' if encode else 'decodeSource')
    worker = os.environ.get('STREAMGLASS_SCRIPT_URL')
    if not source or not worker or not service.http:
        raise ValueError('Custom codec source or JavaScript worker is unavailable')
    # Same isolated QuickJS worker as rules; no host functions, files or network.
    wrapper = 'const onResponse = async (context,url,request,response) => { const codec = (' + source + '); const body = await codec(response.body, response.headers, context); if (typeof body !== "string") throw Error("Codec must return text"); return {...response,body}; };'
    async with service.http.post(worker.rstrip('/') + '/execute', json={'source': wrapper, 'hook': 'onResponse', 'context': {'direction': 'encode' if encode else 'decode', 'url': url, 'request': copy.deepcopy(request_context or {})}, 'url': url, 'request': copy.deepcopy(request_context or {}), 'response': {**value, 'body': bounded(text)}}, headers={'Authorization': 'Bearer ' + service.token}) as response:
        result = await response.json()
        if response.status != 200:
            raise ValueError('Custom codec failed in sandbox')
        return bounded(result.get('value', {}).get('body'))


async def decode(service, url, value, codec_id=None, request_context=None):
    profile = select(service, url, value, codec_id)
    body = await convert(service, profile, value.get('body', ''), value, url, request_context=request_context)
    return {'codecId': profile['id'], 'body': body, 'editable': bool(profile['allowEditing'] and (profile['kind'] != 'custom-js' or profile.get('encodeSource'))), 'warning': 'Primitive codec only; native bundle envelopes and signatures require a matching custom codec. CBC/CTR do not authenticate the key or plaintext.'}


async def prepare_decoded(service, gate, decoded, value):
    if gate['stage'] != 'response' or not isinstance(decoded, dict) or set(decoded) != {'codecId', 'body'}:
        raise ValueError('Decoded edits require a response breakpoint and codecId/body')
    original = gate['value']
    profile = select(service, gate['url'], original, decoded['codecId'])
    request_context = getattr(service, 'records', {}).get(gate.get('recordId'), {}).get('request', {})
    before = await decode(service, gate['url'], original, profile['id'], request_context)
    body = bounded(decoded['body'])
    if not before['editable']:
        raise ValueError('This codec is read only')
    result = copy.deepcopy(value)
    protected = {'x-nonce', 'x-bundle-id'}
    headers = result.get('headers', original.get('headers', []))
    if not isinstance(headers, list) or any(not isinstance(pair, (list, tuple)) or len(pair) != 2 or any(not isinstance(item, str) for item in pair) for pair in headers):
        raise ValueError('Headers must be pairs of strings')
    original_protected = [pair for pair in original.get('headers', []) if pair[0].lower() in protected]
    if [pair for pair in headers if pair[0].lower() in protected] != original_protected:
        result['headers'] = [pair for pair in headers if pair[0].lower() not in protected] + original_protected
    if body == before['body']:
        for key in ('body', 'bodyBase64'):
            if key in original:
                result[key] = original[key]
        return result
    encoded = await convert(service, profile, body, original, gate['url'], True, request_context)
    # Verify inverse before releasing traffic; encoding failure leaves the gate pending.
    if await convert(service, profile, encoded, original, gate['url'], request_context=request_context) != body:
        raise ValueError('Codec encode/decode verification failed')
    result['body'] = encoded
    result.pop('bodyBase64', None)
    return result


def install(app, service):
    async def profiles(request):
        if request.method == 'PUT':
            checked = validate_profiles(await request.json())
            service.persist_config(codecs=checked)
            service.codec_keys = {k: v for k, v in service.codec_keys.items() if any(p['id'] == k for p in checked)}
        return web.json_response(service.codecs)

    async def set_key(request):
        profile = next((p for p in service.codecs if p['id'] == request.match_info['id']), None)
        if not profile or not profile['kind'].startswith('aes-'):
            raise ValueError('Select an AES codec')
        value = await request.json()
        if not isinstance(value, dict) or set(value) != {'key'} or not isinstance(value['key'], str) or len(value['key']) > 1024:
            raise ValueError('Expected a session key string under 1024 characters')
        supplied = value['key']
        if supplied:
            key_bytes(profile, supplied)
            service.codec_keys[profile['id']] = supplied
        else:
            service.codec_keys.pop(profile['id'], None)
        return web.json_response({'configured': bool(supplied)})

    async def inspect(request):
        options = await request.json()
        if not isinstance(options, dict) or set(options) - {'codecId'} or ('codecId' in options and not isinstance(options['codecId'], str)):
            raise ValueError('Expected optional codecId')
        gate_token = request.match_info.get('token')
        if gate_token:
            gate = service.pending.get(gate_token)
            if not gate or gate['future'].done():
                raise web.HTTPConflict(reason='Breakpoint is no longer pending')
            if gate['stage'] != 'response':
                raise ValueError('Only response bodies support codecs')
            url, value = gate['url'], gate['value']
            request_context = service.records.get(gate['recordId'], {}).get('request', {})
        else:
            record = service.records.get(request.match_info['id'])
            if not record:
                raise web.HTTPNotFound()
            url, value = record['url'], record.get('response')
            request_context = record.get('request', {})
            if not value:
                raise ValueError('Response body unavailable')
        return web.json_response(await decode(service, url, value, options.get('codecId'), request_context))

    app.add_routes([web.get('/api/codecs', profiles), web.put('/api/codecs', profiles), web.post('/api/codecs/{id}/key', set_key), web.post('/api/records/{id}/decode', inspect), web.post('/api/pending/{token}/decode', inspect)])
