import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './mcp-tools.mjs';

const { version } = createRequire(import.meta.url)('../package.json');

const MAX_SESSIONS = 16;
const MAX_REQUESTS = 64;
const MAX_PENDING = 8;
const IDLE_MS = 5 * 60_000;
const MAX_BODY = 256 * 1024;

function reply(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw Object.assign(new Error('Expected application/json'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

/** A dedicated local MCP listener; authToken must be independent of engine credentials. */
export async function startMcpServer({ port = 48722, authToken, bootstrap, workspaces }) {
  if (typeof authToken !== 'string' || authToken.length < 32 || /[\r\n]/.test(authToken)) {
    throw new Error('MCP requires a dedicated bearer token of at least 32 characters');
  }
  const expectedAuth = Buffer.from(`Bearer ${authToken}`);
  const sessions = new Map();
  let activeRequests = 0;
  let closing = false;
  let actualPort;

  async function createSession(transport, id) {
    if (closing) throw Object.assign(new Error('MCP listener is shutting down'), { status: 503 });
    const session = { transport, id, lastActive: Date.now(), pending: new Set() };
    sessions.set(id, session);
    const server = new McpServer({ name: 'streamglass', version }, { capabilities: { logging: {} } });
    transport.onclose = () => { sessions.delete(session.id); };
    try { registerTools(server, { ...bootstrap, workspaces }); await server.connect(transport); }
    catch (error) { sessions.delete(id); await transport.close(); throw error; }
    const receive = transport.onmessage;
    const send = transport.send.bind(transport);
    transport.onmessage = (message, extra) => {
      session.lastActive = Date.now();
      if ('id' in message && 'method' in message) {
        if (session.pending.size >= MAX_PENDING || session.pending.has(message.id)) {
          void send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Too many pending requests or duplicate request id' } }).catch(() => {});
          return;
        }
        session.pending.add(message.id);
      }
      receive(message, extra);
    };
    transport.send = async (message, options) => {
      session.lastActive = Date.now();
      if ('id' in message && !('method' in message)) session.pending.delete(message.id);
      return send(message, options);
    };
    return session;
  }

  const listener = http.createServer(async (req, res) => {
    const host = req.headers.host;
    if (req.headers.origin !== undefined || ![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host)) {
      reply(res, 403, 'Only local non-browser clients are allowed'); return;
    }
    const receivedAuth = Buffer.from(req.headers.authorization ?? '');
    if (receivedAuth.length !== expectedAuth.length || !timingSafeEqual(receivedAuth, expectedAuth)) {
      reply(res, 401, 'Bearer authentication required'); return;
    }
    if (closing || activeRequests >= MAX_REQUESTS) { reply(res, 503, 'MCP listener is busy'); return; }
    activeRequests++;
    res.once('close', () => { activeRequests--; });
    try {
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      if (url.pathname === '/sse' && req.method === 'GET') {
        if (sessions.size >= MAX_SESSIONS) { reply(res, 503, 'Too many MCP sessions'); return; }
        const transport = new SSEServerTransport('/messages', res);
        await createSession(transport, transport.sessionId);
        return;
      }
      if (url.pathname === '/messages' && req.method === 'POST') {
        const session = sessions.get(url.searchParams.get('sessionId'));
        if (!(session?.transport instanceof SSEServerTransport)) { reply(res, 404, 'Session not found'); return; }
        const body = await readBody(req);
        await session.transport.handlePostMessage(req, res, body);
        return;
      }
      if (url.pathname !== '/mcp') { reply(res, 404, 'Endpoint not found'); return; }
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) { reply(res, 405, 'Method not allowed'); return; }
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const sessionId = req.headers['mcp-session-id'];
      let session = sessions.get(sessionId);
      if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
        if (sessions.size >= MAX_SESSIONS) { reply(res, 503, 'Too many MCP sessions'); return; }
        const id = randomUUID();
        session = await createSession(new StreamableHTTPServerTransport({ sessionIdGenerator: () => id }), id);
      } else if (!(session?.transport instanceof StreamableHTTPServerTransport)) {
        reply(res, sessionId ? 404 : 400, 'Valid MCP session required'); return;
      }
      session.lastActive = Date.now();
      await session.transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) reply(res, error.status ?? 500, error.status ? error.message : 'MCP request failed');
      else if (!res.writableEnded) res.end();
    }
  });
  listener.requestTimeout = 15_000;
  listener.headersTimeout = 10_000;
  listener.maxConnections = 80;
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', () => {
      actualPort = listener.address().port;
      listener.removeListener('error', reject);
      resolve();
    });
  });
  const sweep = setInterval(() => {
    for (const session of sessions.values()) {
      if (Date.now() - session.lastActive >= IDLE_MS) void session.transport.close().catch(() => {});
    }
  }, 30_000);
  sweep.unref();
  let closePromise;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/mcp`,
    sseUrl: `http://127.0.0.1:${actualPort}/sse`,
    get sessionCount() { return sessions.size; },
    close() {
      closePromise ??= (async () => {
        closing = true;
        clearInterval(sweep);
        const closed = new Promise(resolve => listener.close(resolve));
        await Promise.allSettled([...sessions.values()].map(session => session.transport.close()));
        sessions.clear();
        listener.closeAllConnections();
        await closed;
      })();
      return closePromise;
    },
  };
}
