const tokenPattern = /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g;

export function prepareJson(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined || text === '') return { text: 'No body', isJson: false };
    JSON.parse(text);
  } catch {
    return { text: typeof value === 'string' ? value : String(value ?? ''), isJson: false };
  }
  // Format lexical tokens so large integers and exponent notation remain exact.
  const pattern = new RegExp(tokenPattern);
  const chunks = [];
  let depth = 0;
  let previous = '';
  const indent = () => '  '.repeat(Math.min(depth, 100));
  for (let match; (match = pattern.exec(text));) {
    const token = match[0];
    if (token === '}' || token === ']') {
      depth--;
      if (previous !== '{' && previous !== '[') chunks.push('\n', indent());
    } else if (previous === '{' || previous === '[' || previous === ',') {
      chunks.push('\n', indent());
    }
    chunks.push(token);
    if (token === ':') chunks.push(' ');
    if (token === '{' || token === '[') depth++;
    previous = token;
  }
  return { text: chunks.join(''), isJson: true };
}

export function jsonPage(text, start = 0) {
  const limit = Math.min(text.length, start + 65536);
  let end = start;
  let newlines = 0;
  while (end < limit) {
    if (text[end++] === '\n' && ++newlines === 200) break;
  }
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return { text: text.slice(start, end), start, end, hasNext: end < text.length };
}

export function jsonHighlights(text, start, end) {
  const pattern = new RegExp(tokenPattern);
  const tokens = [];
  let position = start;
  for (let match; (match = pattern.exec(text)) && match.index < end;) {
    const tokenEnd = match.index + match[0].length;
    if (tokenEnd <= start) continue;
    const tokenStart = Math.max(start, match.index);
    if (tokenStart > position) tokens.push({ text: text.slice(position, tokenStart), kind: '' });
    const token = match[0];
    const kind = token[0] === '"'
      ? (text.slice(tokenEnd).match(/^\s*:/) ? 'property' : 'string')
      : token === 'true' || token === 'false' ? 'boolean'
      : token === 'null' ? 'null'
      : /^-?\d/.test(token) ? 'number' : 'punctuation';
    position = Math.min(tokenEnd, end);
    tokens.push({ text: text.slice(tokenStart, position), kind });
  }
  if (position < end) tokens.push({ text: text.slice(position, end), kind: '' });
  return tokens;
}

// Offsets refer to the source string, never a parsed/reserialized JSON value.
export function jsonContainers(text) {
  const pattern = new RegExp(tokenPattern);
  const stack = [];
  const ranges = [];
  for (let match; (match = pattern.exec(text));) {
    if (match[0] === '{' || match[0] === '[') {
      const range = { start: match.index, end: 0, kind: match[0] === '{' ? 'object' : 'array' };
      stack.push(range);
      ranges.push(range);
    } else if (match[0] === '}' || match[0] === ']') {
      const range = stack.pop();
      if (range) range.end = match.index + 1;
    }
  }
  return ranges.filter(range => range.end > range.start);
}

export function foldJson(text, ranges, collapsed) {
  const chunks = [];
  const visible = [];
  let position = 0;
  let length = 0;
  for (const range of ranges) {
    if (range.start < position) continue;
    const prefix = text.slice(position, range.start);
    chunks.push(prefix);
    length += prefix.length;
    visible.push({ ...range, displayStart: length });
    const folded = collapsed.has(range.start);
    const chunk = folded ? text[range.start] + ' … ' + text[range.end - 1] : text[range.start];
    chunks.push(chunk);
    length += chunk.length;
    position = folded ? range.end : range.start + 1;
  }
  chunks.push(text.slice(position));
  return { text: chunks.join(''), ranges: visible };
}

export function replaceJsonContainer(text, range, replacement) {
  if (!replacement.trim()) throw new Error('Enter a JSON value to replace this container.');
  JSON.parse(replacement); // Validate only; preserve exact numeric/string lexemes below.
  return text.slice(0, range.start) + replacement + text.slice(range.end);
}
