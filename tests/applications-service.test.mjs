import test from 'node:test';
import assert from 'node:assert/strict';
import { startScriptService } from '../electron/script-service.mjs';

test('application lookup bridge authenticates and validates connection tuples independently of scripts', async () => {
  const calls = [];
  const token = 'application-test-token-not-a-secret';
  const service = await startScriptService(token, { resolveApplication: async input => {
    calls.push(input);
    return { clientIsLocal: true, application: { id: 'process:test', name: 'Test', pid: 123, kind: 'process' } };
  } });
  try {
    const input = { clientHost: '127.0.0.1', clientPort: 12345, proxyPort: 8080 };
    const post = (body, headers = {}) => fetch(service.url + '/application', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
    assert.equal((await post(input, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(input, { Origin: 'https://untrusted.example' })).status, 404);
    assert.equal((await post({ ...input, clientHost: 'example.com' })).status, 400);
    assert.equal((await post({ ...input, clientPort: 0 })).status, 400);
    assert.equal((await post({ ...input, executable: '/tmp/arbitrary' })).status, 400);
    const response = await post(input);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).application.name, 'Test');
    assert.deepEqual(calls, [input]);
  } finally { service.close(); }
});
