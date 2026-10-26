import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCaptures, comparisonText, redactCapture } from './capture-tools.mjs';
const options = {section:'response', ignoreFields:[], eventKey:'sequence'};
const capture = body => ({state:'complete', response:{body, headers:[]}});
test('structural comparison preserves large numbers and ignores exact keys and paths', () => {
  const result = compareCaptures(capture('{"id":9007199254740992,"nested":{"time":1},"same":true}'), capture('{"same":true,"id":9007199254740993,"nested":{"time":2}}'), {...options,ignoreFields:['time']});
  assert.deepEqual(result.changes,[{path:'/response/body/id',before:'9007199254740992',after:'9007199254740993'}]);
  assert.equal(result.incomplete,false);
  assert.equal(compareCaptures(capture('{"x":1}'),capture('{"x":2}'),{...options,ignoreFields:['/response/body/x']}).totalChanges,0);
});
test('header casing is ignored while repeated values remain visible', () => {
  const left=capture('');left.response.headers=[['X-Test','one'],['x-test','two']];
  const right=capture('');right.response.headers=[['x-test','one'],['X-TEST','three']];
  assert.deepEqual(compareCaptures(left,right,options).changes,[{path:'/response/headers/x-test/1',before:'two',after:'three'}]);
});
test('events align repeated IDs by occurrence without dropping events', () => {
  const left={state:'complete',events:[{id:'a',data:'{"value":1}'},{id:'a',data:'{"value":2}'}]};
  const right={state:'complete',events:[{id:'a',data:'{"value":1}'},{id:'a',data:'{"value":3}'}]};
  const result=compareCaptures(left,right,{...options,section:'events',eventKey:'id'});
  assert.equal(result.totalChanges,1);assert.equal(result.changes[0].before,'2');assert.equal(result.changes[0].after,'3');
});
test('incomplete captures always warn and large diffs are bounded', () => {
  const value=capture('');value.response.bodyUnavailable=true;
  assert.equal(compareCaptures(value,value,options).incomplete,true);
  assert.ok(compareCaptures(value,value,options).warnings.length);
  const a=capture(JSON.stringify(Array.from({length:600},()=>1)));const b=capture(JSON.stringify(Array.from({length:600},()=>2)));
  const result=compareCaptures(a,b,options);assert.equal(result.totalChanges,600);assert.equal(result.changes.length,500);
});
test('redaction removes alternate bytes, duplicate credentials, nested JSON and event secrets without rounding', () => {
  const record={state:'complete',url:'https://user:password@example.com/?token=secret&token=secret2&keep=yes',request:{headers:[['Authorization','secret'],['authorization','secret2']],body:'{"id":9007199254740993,"nested":{"password":"secret","email":"personal"}}',bodyBase64:'hidden-secret',raw:'hidden-secret',logs:['hidden-secret']},response:{body:'not-json-secret',bodyHex:'hidden-secret'},events:[{data:'{"token":"secret","id":9007199254740993}',raw:'hidden-secret'}]};
  const original=structuredClone(record);const result=redactCapture(record,{fields:['email']});const serialized=JSON.stringify(result);
  assert.equal(serialized.includes('secret'),false);assert.equal(serialized.includes('personal'),false);assert.equal(serialized.includes('hidden-secret'),false);
  assert.ok(result.request.body.includes('9007199254740993'));assert.ok(result.events[0].data.includes('9007199254740993'));
  assert.deepEqual(result.request.headers.map(header=>header[1]),['[REDACTED]','[REDACTED]']);assert.ok(result.redactionWarnings.length);assert.deepEqual(record,original);
});
test('large comparisons are explicitly unevaluated and large redactions omit source secrets', () => {
  const source='"'+'private-secret'.repeat(330000)+'"';
  const value=capture(source);
  // Two sides of 43 MB exceed the 80 MiB comparison budget; lengths alone decide, nothing is encoded.
  const huge=capture('"'+'x'.repeat(43_000_000)+'"');
  const comparison=compareCaptures(huge,huge,options);
  assert.equal(comparison.limited,true);assert.equal(comparison.incomplete,true);
  assert.equal(comparison.totalChanges,0);assert.deepEqual(comparison.changes,[]);
  assert.match(comparison.warnings[0],/not evaluated/i);
  const redacted=redactCapture(value,{fields:[]});
  assert.equal(JSON.stringify(redacted).includes('private-secret'),false);
  assert.match(redacted.redactionWarnings[0],/4 MiB/);
});
test('redaction preserves an own __proto__ property without mutating prototypes', () => {
  const value=JSON.parse('{"__proto__":{"password":"secret"},"state":"complete"}');
  const result=redactCapture(value,{fields:[]});
  assert.equal(Object.getPrototypeOf(result),null);
  assert.equal(Object.hasOwn(result,'__proto__'),true);
  assert.equal(JSON.stringify(result).includes('secret'),false);
});

test('diff documents are sorted pretty JSON that keeps lexemes and honors ignore rules', () => {
  const left = { response: { statusCode: 200, headers: [['X-Nonce', 'a'], ['Content-Type', 'application/json'], ['Set-Cookie', 'one'], ['Set-Cookie', 'two']], body: '{"b":9007199254740993123,"a":[1,{"z":null,"id":"x"}],"e":{}}' } };
  const text = comparisonText(left, { section: 'response', ignoreFields: ['x-nonce', 'id'], eventKey: 'sequence' });
  assert.equal(text, '{\n  "statusCode": 200,\n  "headers": {\n    "content-type": "application/json",\n    "set-cookie": ["one", "two"]\n  },\n  "body": {\n    "a": [\n      1,\n      {\n        "z": null\n      }\n    ],\n    "b": 9007199254740993123,\n    "e": {}\n  }\n}');
  assert.equal(comparisonText({ response: { body: 'not json' } }, { section: 'response', ignoreFields: [], eventKey: 'sequence' }), '{\n  "headers": {},\n  "body": "not json"\n}');
  assert.equal(comparisonText({ events: [{ sequence: 1, event: 'm', data: '{"n":1}' }] }, { section: 'events', ignoreFields: [], eventKey: 'sequence' }), '[\n  {\n    "sequence": 1,\n    "event": "m",\n    "data": {\n      "n": 1\n    }\n  }\n]');
});

test('comparisons read captures beyond the old 4 MiB budget', () => {
  const events = n => Array.from({ length: 12000 }, (_, i) => ({ sequence: i + 1, data: JSON.stringify({ i, value: i === 7 ? n : 0, text: 'x'.repeat(400) }) }));
  const left = { state: 'complete', events: events(1) }, right = { state: 'complete', events: events(2) };
  const result = compareCaptures(left, right, { section: 'events', ignoreFields: [], eventKey: 'sequence' });
  assert.equal(result.limited, undefined);
  assert.equal(result.totalChanges, 1);
  assert.equal(result.changes[0].path, '/events/8/0/data/value');
});

test('custom JSON compares against a capture body, request body or event data', async () => {
  const { bodyRecord } = await import('./capture-tools.mjs');
  const record = { state: 'complete', request: { body: '{"q":1}' }, response: { statusCode: 200, headers: [['Date', 'x']], body: '{"a":1,"b":[1,2]}' }, events: [{ sequence: 1, data: '{"n":1}' }, { sequence: 2, data: 'plain' }] };
  const body = { section: 'response', ignoreFields: [], eventKey: 'sequence', bodyOnly: true };
  const result = compareCaptures(bodyRecord(record, 'response'), bodyRecord({ custom: '{"b":[1,3],"a":1}' }), body);
  assert.deepEqual(result.changes, [{ path: '/body/b/1', before: '2', after: '3' }]);
  assert.equal(comparisonText(bodyRecord({ custom: '{"b":1,"a":2}' }), body), '{\n  "a": 2,\n  "b": 1\n}');
  assert.equal(compareCaptures(bodyRecord(record, 'request'), bodyRecord({ custom: '{"q":1}' }), body).totalChanges, 0);
  assert.equal(bodyRecord(record, 'events').response.body, '[{"n":1},"plain"]');
  assert.equal(compareCaptures(bodyRecord({ custom: 'not json' }), bodyRecord({ custom: 'not json!' }), body).totalChanges, 1);
});

test('minified and formatted JSON compare equal, and a path narrows the comparison', async () => {
  const { bodyRecord, formatJson } = await import('./capture-tools.mjs');
  const body = { section: 'response', ignoreFields: [], eventKey: 'sequence', bodyOnly: true };
  const capture = { state: 'complete', response: { body: '{\n  "meta": { "nonce": "a" },\n  "data": { "items": [1, 9007199254740993123] }\n}' } };
  const pasted = '{"data":{"items":[1,9007199254740993123]},"meta":{"nonce":"b"}}';
  assert.equal(compareCaptures(bodyRecord(capture), bodyRecord({ custom: pasted }), body).totalChanges, 1);
  assert.equal(compareCaptures(bodyRecord(capture, 'response', 'data'), bodyRecord({ custom: pasted }, 'response', 'data'), body).totalChanges, 0);
  assert.equal(compareCaptures(bodyRecord(capture, 'response', '$.data.items[1]'), bodyRecord({ custom: '9007199254740993124' }), body).changes[0].after, '9007199254740993124');
  assert.equal(bodyRecord(capture, 'response', 'missing').response.body, '"(path not found)"');
  assert.equal(formatJson('{"b":1,"a":[2]}'), '{\n  "b": 1,\n  "a": [\n    2\n  ]\n}');
  assert.throws(() => formatJson('{'));
});
