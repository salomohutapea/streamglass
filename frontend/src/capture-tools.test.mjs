import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCaptures, redactCapture } from './capture-tools.mjs';
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
  const comparison=compareCaptures(value,value,options);
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
