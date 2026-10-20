import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, functionMask, maskFunction, maxBytes, reedSolomon } from './qr-code.mjs';

const DATA = { 1: [1, 16], 2: [1, 28], 3: [1, 44], 4: [2, 32], 5: [2, 43], 6: [4, 27], 7: [4, 31], 8: [[2, 38], [2, 39]], 9: [[3, 36], [2, 37]], 10: [[4, 43], [1, 44]] };
const EC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];

function decode(qr) {
  const { size, modules, version } = qr;
  const reserved = functionMask(version);
  const words = [];
  let row = size - 1, inc = -1, bit = 7, cur = 0;
  const mask = maskFunction[qr.mask];
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (reserved[row][col - c]) continue;
        let v = modules[row][col - c];
        if (mask(row, col - c)) v = !v;
        cur = (cur << 1) | (v ? 1 : 0);
        if (--bit < 0) { words.push(cur); cur = 0; bit = 7; }
      }
      row += inc;
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
    }
  }
  const groups = (Array.isArray(DATA[version][0]) ? DATA[version] : [DATA[version]]);
  const sizes = groups.flatMap(([count, len]) => Array(count).fill(len));
  const blocks = sizes.map(() => ({ data: [], ec: [] }));
  const max = Math.max(...sizes);
  let k = 0;
  for (let i = 0; i < max; i++) blocks.forEach((b, j) => { if (i < sizes[j]) b.data.push(words[k++]); });
  for (let i = 0; i < EC[version]; i++) blocks.forEach(b => b.ec.push(words[k++]));
  for (const b of blocks) assert.deepEqual(reedSolomon(b.data, EC[version]), b.ec);
  const data = blocks.flatMap(b => b.data);
  const bits = data.map(b => b.toString(2).padStart(8, '0')).join('');
  assert.equal(bits.slice(0, 4), '0100');
  const lenBits = version >= 10 ? 16 : 8;
  const length = parseInt(bits.slice(4, 4 + lenBits), 2);
  const out = [];
  for (let i = 0; i < length; i++) out.push(parseInt(bits.slice(4 + lenBits + i * 8, 12 + lenBits + i * 8), 2));
  return new TextDecoder().decode(new Uint8Array(out));
}

test('reed solomon matches the published HELLO WORLD style vector for 1-M data', () => {
  // Known ISO 18004 example: data codewords of "01234567" version 1-M
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  assert.deepEqual(reedSolomon(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
});

test('encodes and decodes proxy summaries across versions', () => {
  for (const text of ['Proxy 192.0.2.10:9090', 'a', 'x'.repeat(14), 'x'.repeat(15), 'p'.repeat(100), 'q'.repeat(180), 'r'.repeat(213), 'é-✓ synthetic']) {
    const qr = encodeQr(text);
    assert.equal(qr.size, 17 + 4 * qr.version);
    assert.equal(decode(qr), text);
  }
});

test('version selection and limits', () => {
  assert.equal(encodeQr('x'.repeat(14)).version, 1);
  assert.equal(encodeQr('x'.repeat(15)).version, 2);
  assert.equal(maxBytes(10), 213);
  assert.throws(() => encodeQr('x'.repeat(214)), RangeError);
});

test('finder patterns and fixed modules are in place', () => {
  const { modules, size } = encodeQr('Proxy 192.0.2.10:9090');
  for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(modules[r][c], true);
    assert.equal(modules[r + 1][c + 1], false);
    assert.equal(modules[r + 3][c + 3], true);
  }
  assert.equal(modules[size - 8][8], true);
});
