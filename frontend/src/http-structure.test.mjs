import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, parseCookies, parseSetCookie, parseUrlEncoded, parseMultipart, requestStructure, imageDataUrl, formatSize } from './http-structure.mjs';

test('query and form values are decoded', () => {
  assert.deepEqual(parseQuery('https://x.test/a?q=a%20b&flag&e=1+2#frag'), [{ name: 'q', value: 'a b' }, { name: 'flag', value: '' }, { name: 'e', value: '1 2' }]);
  assert.deepEqual(parseQuery('https://x.test/a'), []);
  assert.deepEqual(parseUrlEncoded('a=%E2%9C%93&b=%ZZ'), [{ name: 'a', value: '✓' }, { name: 'b', value: '%ZZ' }]);
});

test('cookies and set-cookie', () => {
  assert.deepEqual(parseCookies('a=1; b=x=y'), [{ name: 'a', value: '1' }, { name: 'b', value: 'x=y' }]);
  const [c] = parseSetCookie(['sid=abc; Path=/; Domain=x.test; Secure; HttpOnly; SameSite=Lax; Max-Age=60']);
  assert.equal(c.name, 'sid');
  assert.equal(c.path, '/');
  assert.equal(c.expires, '60');
  assert.deepEqual(c.flags, ['Secure', 'HttpOnly', 'SameSite=Lax']);
});

test('multipart parts', () => {
  const body = '--B\r\nContent-Disposition: form-data; name="title"\r\n\r\nhello\r\n--B\r\nContent-Disposition: form-data; name="f"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\u0001\u0002\u0003\r\n--B--\r\n';
  const parts = parseMultipart('multipart/form-data; boundary=B', Buffer.from(body).toString('base64'));
  assert.equal(parts.length, 2);
  assert.deepEqual([parts[0].name, parts[0].size, parts[0].text], ['title', 5, 'hello']);
  assert.deepEqual([parts[1].name, parts[1].filename, parts[1].contentType, parts[1].size, parts[1].text], ['f', 'a.bin', 'application/octet-stream', 3, undefined]);
  assert.deepEqual(parseMultipart('multipart/form-data', 'AAAA'), []);
});

test('requestStructure picks the matching body parser', () => {
  const s = requestStructure({ url: 'https://x.test/?a=1', headers: [['Content-Type', 'application/x-www-form-urlencoded'], ['Cookie', 'k=v']], body: 'n=1' });
  assert.equal(s.query.length, 1);
  assert.deepEqual(s.form, [{ name: 'n', value: '1' }]);
  assert.equal(s.cookies[0].name, 'k');
});

test('images only produce data urls for allowed types', () => {
  assert.equal(imageDataUrl([['Content-Type', 'image/svg+xml; charset=utf-8']], 'AAAA'), 'data:image/svg+xml;base64,AAAA');
  assert.equal(imageDataUrl([['content-type', 'text/html']], 'AAAA'), '');
  assert.equal(imageDataUrl([['content-type', 'image/png']], '" onerror='), '');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(null), '—');
});
