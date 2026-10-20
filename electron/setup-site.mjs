import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Read-only phone setup site. It serves only the public CA certificate, a CA-only iOS profile, a PAC file and a
// static instruction page. The only dynamic values are the Mac LAN address and proxy port. No captured data.
const MAX_URL = 256;
const PEM = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/;
const escapeXml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
const validHost = value => typeof value === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;
const uuidFrom = (seed, label) => { const h = createHash('sha256').update(`${label}:${seed}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`.toUpperCase(); };

export function parsePublicCertificate(pem) {
  if (typeof pem !== 'string' || pem.includes('PRIVATE KEY')) throw new Error('A public PEM certificate is required');
  const match = PEM.exec(pem);
  if (!match) throw new Error('A public PEM certificate is required');
  const base64 = match[1].replace(/\s+/g, '');
  const der = Buffer.from(base64, 'base64');
  if (!der.length) throw new Error('A public PEM certificate is required');
  const lines = base64.match(/.{1,64}/g).join('\n');
  return { der, pem: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n` };
}

export function buildPac(host, port) {
  if (!validHost(host) || !validPort(port)) throw new Error('Invalid proxy address');
  return `function FindProxyForURL(url, host) {\n  return "PROXY ${host}:${port}; DIRECT";\n}\n`;
}

export function buildMobileConfig(certificate) {
  const { der } = certificate;
  const seed = createHash('sha256').update(der).digest('hex');
  const data = der.toString('base64').match(/.{1,64}/g).join('\n\t\t\t');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadCertificateFileName</key>
			<string>streamglass-ca.cer</string>
			<key>PayloadContent</key>
			<data>
			${data}
			</data>
			<key>PayloadDescription</key>
			<string>Streamglass root certificate (public certificate only)</string>
			<key>PayloadDisplayName</key>
			<string>Streamglass CA</string>
			<key>PayloadIdentifier</key>
			<string>app.streamglass.ca.cert</string>
			<key>PayloadType</key>
			<string>com.apple.security.root</string>
			<key>PayloadUUID</key>
			<string>${uuidFrom(seed, 'cert')}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Installs the Streamglass root certificate. Remove it when you finish debugging.</string>
	<key>PayloadDisplayName</key>
	<string>Streamglass CA</string>
	<key>PayloadIdentifier</key>
	<string>app.streamglass.ca</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${uuidFrom(seed, 'profile')}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}

export function buildSetupPage(host, port, setupPort) {
  const proxy = `${escapeXml(host)}:${port}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Streamglass phone setup</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0 auto;max-width:36rem;padding:1rem;color:#1c1c1e;background:#f5f5f7}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.6rem}code{background:#e5e5ea;padding:.1rem .35rem;border-radius:4px;word-break:break-all}a.btn{display:block;margin:.5rem 0;padding:.75rem 1rem;background:#0a84ff;color:#fff;text-decoration:none;border-radius:10px;text-align:center}li{margin:.4rem 0}.note{color:#555;font-size:.9rem}@media(prefers-color-scheme:dark){body{background:#000;color:#f2f2f7}code{background:#2c2c2e}.note{color:#aaa}}</style></head><body>
<h1>Streamglass phone setup</h1>
<p>Proxy: <code>${proxy}</code><br>Auto proxy (PAC): <code>http://${escapeXml(host)}:${Number(setupPort)}/proxy.pac</code></p>
<h2>iPhone / iPad</h2>
<ol>
<li>Settings, Wi-Fi, (i) next to your network, Configure Proxy, Manual. Server <code>${escapeXml(host)}</code>, port <code>${port}</code>. Or choose Automatic and use the PAC address above.</li>
<li><a class="btn" href="/streamglass.mobileconfig">Download iOS profile</a></li>
<li>Settings, Profile Downloaded, Install.</li>
<li>Settings, General, About, Certificate Trust Settings: enable full trust for Streamglass.</li>
</ol>
<h2>Android</h2>
<ol>
<li>Settings, Wi-Fi, edit your network, Proxy, Manual. Host <code>${escapeXml(host)}</code>, port <code>${port}</code>. Or choose Proxy Auto-Config with the PAC address above.</li>
<li><a class="btn" href="/cert.crt">Download certificate</a></li>
<li>Settings, Security, Install a certificate, CA certificate, select the downloaded file.</li>
<li>Apps must trust user certificates (debug builds can opt in through Network Security Configuration); pinned apps cannot be inspected.</li>
</ol>
<p><a href="/cert.pem">cert.pem</a> (PEM) &middot; <a href="/cert.crt">cert.crt</a> &middot; <a href="/proxy.pac">proxy.pac</a></p>
<p class="note">This page serves only the public Streamglass certificate. Remove the proxy setting and the certificate when you finish.</p>
</body></html>
`;
}

const baseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
};
const respond = (status, type, body, extra = {}) => ({ status, headers: { ...baseHeaders, 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)), ...extra }, body });

// Pure request handler: resolve({method, url, hostHeader}) -> {status, headers, body}.
export function createSetupHandler({ readCertificate, getAddresses, getProxyPort, getSetupPort }) {
  return async function handle({ method, url, hostHeader } = {}) {
    if (method !== 'GET' && method !== 'HEAD') return respond(405, 'text/plain; charset=utf-8', 'Method not allowed\n', { Allow: 'GET, HEAD' });
    if (typeof url !== 'string' || url.length > MAX_URL || !url.startsWith('/') || url.startsWith('//') || /\.\.|%|\\/.test(url)) return respond(404, 'text/plain; charset=utf-8', 'Not found\n');
    let pathname;
    try { pathname = new URL(url, 'http://setup.invalid').pathname; } catch { return respond(404, 'text/plain; charset=utf-8', 'Not found\n'); }
    const addresses = (getAddresses() ?? []).filter(validHost);
    const requested = typeof hostHeader === 'string' ? hostHeader.replace(/:\d+$/, '') : '';
    const host = addresses.includes(requested) ? requested : addresses[0];
    const proxyPort = getProxyPort();
    let result;
    try {
      if (pathname === '/') {
        if (!host) return respond(503, 'text/plain; charset=utf-8', 'No LAN address available\n');
        result = respond(200, 'text/html; charset=utf-8', buildSetupPage(host, proxyPort, getSetupPort()));
      } else if (pathname === '/proxy.pac') {
        if (!host) return respond(503, 'text/plain; charset=utf-8', 'No LAN address available\n');
        result = respond(200, 'application/x-ns-proxy-autoconfig', buildPac(host, proxyPort));
      } else if (pathname === '/cert.pem' || pathname === '/cert.crt' || pathname === '/streamglass.mobileconfig') {
        const certificate = parsePublicCertificate(await readCertificate());
        if (pathname === '/cert.pem') result = respond(200, 'application/x-pem-file', certificate.pem, { 'Content-Disposition': 'attachment; filename="streamglass-ca.pem"' });
        else if (pathname === '/cert.crt') {
          result = { status: 200, headers: { ...baseHeaders, 'Content-Type': 'application/x-x509-ca-cert', 'Content-Length': String(certificate.der.length), 'Content-Disposition': 'attachment; filename="streamglass-ca.crt"' }, body: certificate.der };
        } else result = respond(200, 'application/x-apple-aspen-config', buildMobileConfig(certificate), { 'Content-Disposition': 'attachment; filename="streamglass.mobileconfig"' });
      } else return respond(404, 'text/plain; charset=utf-8', 'Not found\n');
    } catch { return respond(503, 'text/plain; charset=utf-8', 'Certificate unavailable\n'); }
    return result;
  };
}

// Lifecycle wrapper: sync({enabled, port}) starts/stops a node:http server bound to all interfaces.
export function createSetupSite({ handler, bindHost = '0.0.0.0' }) {
  let server, boundPort = null, error = '';
  const stop = async () => {
    const current = server; server = undefined; boundPort = null;
    if (!current) return;
    await new Promise(resolve => { current.close(resolve); current.closeAllConnections?.(); });
  };
  const start = port => new Promise(resolve => {
    const next = createServer(async (request, response) => {
      const result = await handler({ method: request.method, url: request.url, hostHeader: request.headers.host });
      response.writeHead(result.status, result.headers);
      response.end(request.method === 'HEAD' ? undefined : result.body);
    });
    next.headersTimeout = 10000; next.requestTimeout = 10000; next.keepAliveTimeout = 2000; next.maxHeadersCount = 50;
    next.on('clientError', (_e, socket) => socket.destroy());
    next.once('error', failure => { error = failure.code === 'EADDRINUSE' ? `Setup page port ${port} is in use` : failure.message; resolve(); });
    next.listen(port, bindHost, () => { server = next; boundPort = next.address().port; error = ''; resolve(); });
  });
  let queue = Promise.resolve();
  return {
    sync: ({ enabled, port }) => queue = queue.then(async () => {
      if (!enabled || !validPort(port)) { await stop(); error = ''; return; }
      if (server && boundPort === port) return;
      await stop();
      await start(port);
    }),
    status: () => ({ running: Boolean(server), port: boundPort, error }),
    close: () => queue = queue.then(stop),
  };
}
