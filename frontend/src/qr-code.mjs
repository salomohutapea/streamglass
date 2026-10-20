// Small pure QR encoder: byte mode, error correction level M, versions 1-10.
const BLOCKS = [null,
  { ec: 10, groups: [[1, 16]] }, { ec: 16, groups: [[1, 28]] }, { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] }, { ec: 24, groups: [[2, 43]] }, { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] }, { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] }, { ec: 26, groups: [[4, 43], [1, 44]] },
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const EXP = new Array(512), LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    poly.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); });
    poly = next;
  }
  return poly;
}
export function reedSolomon(data, degree) {
  const gen = generator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

const dataCodewords = version => BLOCKS[version].groups.reduce((sum, [count, size]) => sum + count * size, 0);
export const maxBytes = version => dataCodewords(version) - (version >= 10 ? 3 : 2);

function utf8(text) { return [...new TextEncoder().encode(text)]; }

function bch(value, poly) {
  const digits = n => 32 - Math.clz32(n);
  let d = value;
  while (digits(d) >= digits(poly)) d ^= poly << (digits(d) - digits(poly));
  return d;
}

export function functionMask(version) {
  const size = 17 + 4 * version;
  const mask = Array.from({ length: size }, () => new Array(size).fill(false));
  const fill = (r0, c0, h, w) => { for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < size && c < size) mask[r][c] = true; };
  fill(0, 0, 9, 9); fill(0, size - 8, 9, 8); fill(size - 8, 0, 8, 9);
  fill(6, 0, 1, size); fill(0, 6, size, 1);
  const pos = ALIGN[version];
  for (const r of pos) for (const c of pos) {
    if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (c === 6 && r === pos[pos.length - 1])) continue;
    fill(r - 2, c - 2, 5, 5);
  }
  if (version >= 7) { fill(0, size - 11, 6, 3); fill(size - 11, 0, 3, 6); }
  return mask;
}

function codewords(bytes, version) {
  const capacity = dataCodewords(version);
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(4, 4); push(bytes.length, version >= 10 ? 16 : 8);
  bytes.forEach(b => push(b, 8));
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  const { ec, groups } = BLOCKS[version];
  const blocks = [];
  let offset = 0;
  for (const [count, size] of groups) for (let i = 0; i < count; i++) {
    const chunk = data.slice(offset, offset + size); offset += size;
    blocks.push({ data: chunk, ec: reedSolomon(chunk, ec) });
  }
  const out = [];
  const longest = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

export const maskFunction = [
  (i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0, (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

function build(version, words, maskId) {
  const size = 17 + 4 * version;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = functionMask(version);
  const set = (r, c, v) => { m[r][c] = v; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      set(rr, cc, ring !== 2 && ring !== 4);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const pos = ALIGN[version];
  for (const r of pos) for (const c of pos) {
    if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (c === 6 && r === pos[pos.length - 1])) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  set(size - 8, 8, true);
  const mask = maskFunction[maskId];
  let row = size - 1, inc = -1, bit = 7, index = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (reserved[row][col - c]) continue;
        let dark = index < words.length && ((words[index] >>> bit) & 1) === 1;
        if (mask(row, col - c)) dark = !dark;
        m[row][col - c] = dark;
        if (--bit < 0) { index++; bit = 7; }
      }
      row += inc;
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
    }
  }
  const info = (((0 << 3) | maskId) << 10 | bch(((0 << 3) | maskId) << 10, 0x537)) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const v = ((info >> i) & 1) === 1;
    set(i < 6 ? i : i < 8 ? i + 1 : size - 15 + i, 8, v);
    set(8, i < 8 ? size - i - 1 : i < 9 ? 15 - i : 14 - i, v);
  }
  if (version >= 7) {
    const v = (version << 12) | bch(version << 12, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const bitValue = ((v >> i) & 1) === 1;
      set(Math.floor(i / 3), (i % 3) + size - 11, bitValue);
      set((i % 3) + size - 11, Math.floor(i / 3), bitValue);
    }
  }
  return m;
}

function penalty(m) {
  const n = m.length;
  let score = 0, dark = 0;
  const runs = lines => {
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i < n; i++) {
        if (line[i] === line[i - 1]) { run++; if (i === n - 1 && run >= 5) score += run - 2; }
        else { if (run >= 5) score += run - 2; run = 1; }
      }
    }
  };
  runs(m); runs(m.map((_, c) => m.map(row => row[c])));
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const matches = (get, i) => pattern.every((p, k) => get(i + k) === p) || pattern.every((p, k) => get(i + 10 - k) === p);
  for (let a = 0; a < n; a++) for (let b = 0; b <= n - 11; b++) {
    if (matches(k => m[a][k], b)) score += 40;
    if (matches(k => m[k][a], b)) score += 40;
  }
  for (const row of m) for (const cell of row) if (cell) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

export function encodeQr(text) {
  const bytes = utf8(String(text));
  let version = 1;
  while (version <= 10 && bytes.length > maxBytes(version)) version++;
  if (version > 10) throw new RangeError(`QR text too long (${bytes.length} bytes, max ${maxBytes(10)})`);
  const words = codewords(bytes, version);
  let best = null;
  for (let maskId = 0; maskId < 8; maskId++) {
    const modules = build(version, words, maskId);
    const score = penalty(modules);
    if (!best || score < best.score) best = { version, size: modules.length, modules, mask: maskId, score };
  }
  return best;
}
