import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetupHandler, createSetupSite, buildPac, buildSetupPage, buildMobileConfig, parsePublicCertificate, defaultSetupPort } from '../electron/setup-site.mjs';

const der = Buffer.from('synthetic-certificate-bytes-for-tests');
const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`;
const make = (overrides = {}) => createSetupHandler({ readCertificate: async () => pem, getAddresses: () => ['192.168.1.20', '10.0.0.5'], getProxyPort: () => 9090, getSetupPort: () => 9091, ...overrides });

test('serves the setup page with proxy details only', async () => {
  const response = await make()({ method: 'GET', url: '/' });
  assert.equal(response.status, 200);
  assert.match(response.headers['Content-Type'], /^text\/html/);
  assert.match(response.body, /192\.168\.1\.20/);
  assert.match(response.body, /http:\/\/192\.168\.1\.20:9091\/proxy\.pac/);
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
});

test('uses the requested host only when it is a known LAN address', async () => {
  const handler = make();
  assert.match((await handler({ method: 'GET', url: '/proxy.pac', hostHeader: '10.0.0.5:9091' })).body, /PROXY 10\.0\.0\.5:9090; DIRECT/);
  assert.match((await handler({ method: 'GET', url: '/proxy.pac', hostHeader: 'evil.example' })).body, /PROXY 192\.168\.1\.20:9090; DIRECT/);
});

test('serves public certificate in PEM and DER forms', async () => {
  const handler = make();
  const crt = await handler({ method: 'GET', url: '/cert.crt' });
  assert.equal(crt.headers['Content-Type'], 'application/x-x509-ca-cert');
  assert.deepEqual(crt.body, der);
  const dotPem = await handler({ method: 'GET', url: '/cert.pem' });
  assert.match(dotPem.body, /BEGIN CERTIFICATE/);
});

test('mobileconfig carries only the certificate payload', async () => {
  const response = await make()({ method: 'GET', url: '/streamglass.mobileconfig' });
  assert.equal(response.headers['Content-Type'], 'application/x-apple-aspen-config');
  assert.equal(response.body.match(/<string>com\.apple\.[a-z.]+<\/string>/g).length, 1);
  assert.match(response.body, /com\.apple\.security\.root/);
  assert.ok(response.body.replace(/\s/g, '').includes(der.toString('base64')));
  assert.equal(buildMobileConfig(parsePublicCertificate(pem)), buildMobileConfig(parsePublicCertificate(pem)));
});

test('never serves a private key', async () => {
  const handler = make({ readCertificate: async () => `${pem}-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n` });
  for (const url of ['/cert.pem', '/cert.crt', '/streamglass.mobileconfig']) {
    const response = await handler({ method: 'GET', url });
    assert.equal(response.status, 503);
    assert.doesNotMatch(String(response.body), /secret|PRIVATE/);
  }
});

test('allows only GET and HEAD and rejects traversal and unknown paths', async () => {
  const handler = make();
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await handler({ method, url: '/' })).status, 405);
  assert.equal((await handler({ method: 'HEAD', url: '/' })).status, 200);
  for (const url of ['/../etc/passwd', '/%2e%2e/secret', '//evil/', '/cert.pem/..', '/mitmproxy-ca.pem', '/cert.pem%00', 'x', '/' + 'a'.repeat(300), '/api/state']) assert.equal((await handler({ method: 'GET', url })).status, 404, url);
});

test('PAC rejects invalid addresses', () => {
  assert.throws(() => buildPac('1.2.3.4; evil', 9090));
  assert.throws(() => buildPac('1.2.3.4', 0));
  assert.match(buildPac('1.2.3.4', 9090), /"PROXY 1\.2\.3\.4:9090; DIRECT"/);
});

test('reports unavailable when there is no LAN address', async () => {
  assert.equal((await make({ getAddresses: () => [] })({ method: 'GET', url: '/' })).status, 503);
});

test('site starts only when enabled and stops otherwise', async t => {
  const site = createSetupSite({ handler: make(), bindHost: '127.0.0.1' });
  t.after(() => site.close());
  await site.sync({ enabled: false, port: 0 });
  assert.equal(site.status().running, false);
  await site.sync({ enabled: true, port: 18765 });
  const { running, port, error } = site.status();
  if (!running) return t.skip(`port unavailable: ${error}`);
  const response = await fetch(`http://127.0.0.1:${port}/proxy.pac`);
  assert.equal(response.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })).status, 405);
  await site.sync({ enabled: false, port });
  assert.equal(site.status().running, false);
});

test('setup page opens the Android tab for Android browsers and iPhone otherwise', () => {
  assert.match(buildSetupPage('192.168.1.20', 9090, 9091, 'android'), /id="os-android" checked/);
  assert.match(buildSetupPage('192.168.1.20', 9090, 9091), /id="os-ios" checked/);
  assert.match(buildSetupPage('192.168.1.20', 9090, 9091), /Certificate Trust Settings/);
});

test('the default setup port follows the proxy port but skips common dev-server ports', () => {
  assert.equal(defaultSetupPort(9090), 9091);
  assert.equal(defaultSetupPort(8080), 8082);
  assert.equal(defaultSetupPort(7999), 8001);
  assert.equal(defaultSetupPort(18999), 19003);
  assert.equal(defaultSetupPort(65535), 65534);
});
