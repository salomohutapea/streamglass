import test from 'node:test';
import assert from 'node:assert/strict';
import { executeScript } from '../electron/script-service.mjs';

test('isolated request hook changes only its returned data', async () => {
  const result = await executeScript({ source: 'async function onRequest(ctx,url,request) { request.headers.push(["X-Test","yes"]); return request; }', hook: 'onRequest', url: 'https://example.test', request: { headers: [], body: '' } });
  assert.deepEqual(result.value.headers, [['X-Test', 'yes']]);
});
test('guest has no Node process or require', async () => {
  const result = await executeScript({ source: 'function onEvent(ctx,url,request,event) { event.data = typeof process + ":" + typeof require; return event; }', hook: 'onEvent', request: {}, event: { data: '' } });
  assert.equal(result.value.data, 'undefined:undefined');
});
test('an infinite hook is terminated', async () => {
  await assert.rejects(executeScript({ source: 'function onRequest() { while (true) {} }', hook: 'onRequest', request: {} }), /interrupt|deadline/i);
});
