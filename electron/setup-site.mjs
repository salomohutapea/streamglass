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

export function buildSetupPage(host, port, setupPort, platform = 'ios') {
  const h = escapeXml(host), p = Number(port), pac = `http://${h}:${Number(setupPort)}/proxy.pac`;
  const android = platform === 'android';
  const step = (n, body, extra = '') => `<li class="step${extra}"><span class="n">${n}</span><div>${body}</div></li>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>Streamglass setup</title>
<style>
:root{--bg:#0f1012;--panel:#121316;--raised:#17181b;--line:#24262c;--text:#d7d9dd;--muted:#80858e;--accent:#6b8bff;--on-accent:#fff;--warn:#e8a23d;--ok:#3ecf8e}
@media(prefers-color-scheme:light){:root{--bg:#f5f5f7;--panel:#fff;--raised:#f1f1f4;--line:#e3e3e8;--text:#1f2024;--muted:#6b6f78;--accent:#3f5fe0;--warn:#a8680f;--ok:#188a5a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:32rem;margin:0 auto;padding:28px 16px 40px}
header{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.mark{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#213a56,#0b1729);display:grid;place-items:center;color:#b8f5ff;font-weight:800;font-size:20px;box-shadow:0 6px 18px #0004}
h1{font-size:19px;margin:0;font-weight:650}header p{margin:2px 0 0;color:var(--muted);font-size:13px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:12px 0}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px}.kv dt{color:var(--muted)}.kv dd{margin:0}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--raised);border:1px solid var(--line);border-radius:6px;padding:1px 6px;user-select:all;-webkit-user-select:all;word-break:break-all}
.tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;background:var(--raised);border:1px solid var(--line);border-radius:10px;padding:3px;margin:20px 0 6px}
.tabs label{text-align:center;padding:8px;border-radius:8px;font-weight:600;font-size:14px;color:var(--muted);cursor:pointer}
input[name=os]{position:absolute;opacity:0;pointer-events:none}
#os-ios:checked~.tabs label[for=os-ios],#os-android:checked~.tabs label[for=os-android]{background:var(--panel);color:var(--text);box-shadow:0 1px 3px #0003}
.panel{display:none}#os-ios:checked~.p-ios,#os-android:checked~.p-android{display:block}
ol{list-style:none;margin:0;padding:0}
.step{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--line)}.step:last-child{border-bottom:0}
.n{flex:none;width:24px;height:24px;border-radius:50%;background:var(--raised);border:1px solid var(--line);display:grid;place-items:center;font-size:12px;font-weight:700;color:var(--muted)}
.step>div{flex:1;min-width:0}.step p{margin:0}.step code{white-space:nowrap;word-break:normal}.step small{display:block;color:var(--muted);font-size:13px;margin-top:4px}
.btn{display:block;margin-top:10px;padding:12px 14px;background:var(--accent);color:var(--on-accent);text-decoration:none;border-radius:10px;text-align:center;font-weight:600}
.must{margin:4px -10px;padding:12px 10px;border:1px solid color-mix(in srgb,var(--warn) 55%,transparent);background:color-mix(in srgb,var(--warn) 12%,transparent);border-radius:10px}
.must .n{background:var(--warn);border-color:var(--warn);color:#fff}.tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--warn);margin-bottom:2px}
.files{display:flex;gap:8px;flex-wrap:wrap;font-size:13px}.files a{color:var(--accent);text-decoration:none;border:1px solid var(--line);border-radius:8px;padding:6px 10px;background:var(--panel)}
.note{color:var(--muted);font-size:12px;margin-top:18px}
</style></head><body><main>
<header><div class="mark">S</div><div><h1>Streamglass setup</h1><p>Route this device through your Mac and trust its certificate.</p></div></header>
<section class="card"><dl class="kv"><dt>Proxy server</dt><dd><code>${h}</code></dd><dt>Port</dt><dd><code>${p}</code></dd><dt>Auto proxy (PAC)</dt><dd><code>${pac}</code></dd></dl></section>
<input type="radio" name="os" id="os-ios"${android ? '' : ' checked'}><input type="radio" name="os" id="os-android"${android ? ' checked' : ''}>
<div class="tabs" role="tablist"><label for="os-ios">iPhone / iPad</label><label for="os-android">Android</label></div>
<section class="panel p-ios card"><ol>
${step(1, `<p>Set the Wi-Fi proxy</p><small>Settings → Wi-Fi → ⓘ next to your network → Configure Proxy → Manual. Server <code>${h}</code>, port <code>${p}</code>. Or choose Automatic with the PAC address.</small>`)}
${step(2, `<p>Download the profile</p><a class="btn" href="/streamglass.mobileconfig">Download iOS profile</a>`)}
${step(3, `<p>Install it</p><small>Settings → Profile Downloaded → Install.</small>`)}
${step(4, `<span class="tag">Required · easy to miss</span><p>Turn on full trust</p><small>Settings → General → About → <b>Certificate Trust Settings</b> → turn on Streamglass. Installing the profile alone is not enough. Then reopen your app.</small>`, ' must')}
</ol></section>
<section class="panel p-android card"><ol>
${step(1, `<p>Set the Wi-Fi proxy</p><small>Settings → Wi-Fi → edit your network → Proxy → Manual. Host <code>${h}</code>, port <code>${p}</code>. Or choose Proxy Auto-Config with the PAC address.</small>`)}
${step(2, `<p>Download the certificate</p><a class="btn" href="/cert.crt">Download certificate</a>`)}
${step(3, `<p>Install it as a CA certificate</p><small>Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate, then pick the downloaded file.</small>`)}
${step(4, `<span class="tag">Required for apps</span><p>Let your app trust user certificates</p><small>Android 7+ apps ignore user CAs unless a debug build adds a Network Security Configuration with <code>&lt;certificates src="user"/&gt;</code>. Pinned apps cannot be inspected.</small>`, ' must')}
</ol></section>
<div class="files"><a href="/cert.pem">cert.pem</a><a href="/cert.crt">cert.crt</a><a href="/proxy.pac">proxy.pac</a></div>
<p class="note">This page only serves the public Streamglass certificate. Remove the proxy setting and the certificate when you finish.</p>
</main></body></html>
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
  return async function handle({ method, url, hostHeader, userAgent } = {}) {
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
        result = respond(200, 'text/html; charset=utf-8', buildSetupPage(host, proxyPort, getSetupPort(), /android/i.test(String(userAgent ?? '')) ? 'android' : 'ios'));
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
      const result = await handler({ method: request.method, url: request.url, hostHeader: request.headers.host, userAgent: request.headers['user-agent'] });
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
