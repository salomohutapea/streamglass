import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { isIP } from 'node:net';

export function executeScript(input, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./script-worker.mjs', import.meta.url), {
      workerData: input, resourceLimits: { maxOldGenerationSizeMb: 96 },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Script deadline exceeded')), timeout);
    worker.once('message', message => finish(message.ok ? null : new Error(message.error), message.result));
    worker.once('error', error => finish(error));
    worker.once('exit', () => finish(new Error('Script worker exited without a result')));
  });
}

export async function startScriptService(token, { resolveApplication, resolveApplicationIcon } = {}) {
  let active = 0;
  let lookups = 0;
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { error: 'Unauthorized' });
    const application = req.url === '/application' && resolveApplication;
    const icon = req.url === '/application-icon' && resolveApplicationIcon;
    const lookup = application || icon;
    if (req.method !== 'POST' || (!lookup && req.url !== '/execute') || req.headers.origin) return send(404, { error: 'Not found' });
    if (lookup ? lookups >= 16 : active >= 4) return send(429, { error: 'Worker capacity reached' });
    if (lookup) lookups++; else active++;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (lookup ? 8192 : 8 * 1024 * 1024)) { send(413, { error: 'Input exceeds size limit' }); req.destroy(); return; }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (icon) {
        if (!input || typeof input.id !== 'string' || input.id.length > 4096 || Object.keys(input).some(key => key !== 'id')) return send(400, { error: 'Invalid application id' });
        return send(200, await resolveApplicationIcon(input.id));
      }
      if (application) {
        if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['clientHost', 'clientPort', 'proxyPort'].includes(key)) ||
            typeof input.clientHost !== 'string' || !isIP(input.clientHost) ||
            ![input.clientPort, input.proxyPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) return send(400, { error: 'Invalid client connection' });
        return send(200, await resolveApplication(input));
      }
      if (typeof input.source !== 'string' || input.source.length > 128 * 1024 || !['onRequest', 'onResponse', 'onEvent'].includes(input.hook)) return send(400, { error: 'Invalid script or hook' });
      send(200, await executeScript(input));
    } catch (error) {
      send(422, { error: error.message });
    } finally { if (lookup) lookups--; else active--; }
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.closeAllConnections() || server.close() };
}
