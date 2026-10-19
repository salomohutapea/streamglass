import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareJson, jsonPage, jsonHighlights, jsonContainers, foldJson, replaceJsonContainer, findMatches, splitByMatches, pageStartsFor } from '../frontend/src/json-viewer.mjs';

test('pretty JSON preserves exact numeric and string lexemes', () => {
  const source = '{"id":9007199254740993123,"exp":1.00e+40,"nested":[true,null,{"quote":"a\\\"b","line":"\\n","html":"<script>alert(1)</script>"}]}';
  const result = prepareJson(source);
  assert.equal(result.isJson, true);
  assert.match(result.text, /9007199254740993123/);
  assert.match(result.text, /1\.00e\+40/);
  assert.match(result.text, /"line": "\\n"/);
  assert.match(result.text, /<script>alert\(1\)<\/script>/);
  assert.deepEqual(JSON.parse(result.text), JSON.parse(source));
  const tokens = jsonHighlights(result.text, 0, result.text.length);
  assert.equal(tokens.map(token => token.text).join(''), result.text);
  assert.ok(tokens.some(token => token.kind === 'property' && token.text === '"id"'));
  assert.ok(tokens.some(token => token.kind === 'boolean'));
  assert.ok(tokens.some(token => token.kind === 'null'));
});

test('handles empty containers, primitives and non JSON without changing text', () => {
  for (const source of ['{}', '[]', 'null', 'true', '3', '""']) assert.equal(prepareJson(source).text, source);
  for (const source of ['plain text\n<hello>', '{invalid}', ' {"x": 1,} ']) assert.deepEqual(prepareJson(source), { text: source, isJson: false });
  assert.equal(prepareJson('').text, 'No body');
  assert.equal(prepareJson(undefined).text, 'No body');
  assert.equal(prepareJson(null).text, 'null');
  assert.equal(prepareJson({ a: [1] }).text, '{\n  "a": [\n    1\n  ]\n}');
});

test('bounds pages and preserves every character including a huge string across pages', () => {
  const source = prepareJson({ large: 'x'.repeat(140000), list: Array.from({ length: 300 }, (_, i) => i) }).text;
  let offset = 0;
  let reconstructed = '';
  while (offset < source.length) {
    const page = jsonPage(source, offset);
    assert.ok(page.end > offset);
    assert.ok(page.text.length <= 65536);
    assert.ok((page.text.match(/\n/g) ?? []).length <= 200);
    const tokens = jsonHighlights(source, page.start, page.end);
    assert.equal(tokens.map(token => token.text).join(''), page.text);
    if (offset > 0 && offset < 140000) assert.equal(tokens[0].kind, 'string');
    reconstructed += page.text;
    offset = page.end;
  }
  assert.equal(reconstructed, source);
});

test('page boundaries keep Unicode surrogate pairs together', () => {
  const text = 'x'.repeat(65535) + '😀tail';
  const page = jsonPage(text);
  assert.equal(page.text.length, 65535);
  assert.equal(jsonPage(text, page.end).text, '😀tail');
});


test('folds nested objects and arrays without reading bracket characters in strings', () => {
  const text = String.raw`{"items":[{"literal":"} [ \"quoted\"","id":9007199254740993123}],"tail":1.00e+40}`;
  assert.doesNotThrow(() => JSON.parse(text));
  const ranges = jsonContainers(text);
  assert.deepEqual(ranges.map(range => range.kind), ['object', 'array', 'object']);
  const folded = foldJson(text, ranges, new Set([ranges[1].start]));
  assert.equal(folded.text, '{"items":[ … ],"tail":1.00e+40}');
  assert.deepEqual(folded.ranges.map(range => range.start), ranges.slice(0, 2).map(range => range.start));
  assert.equal(folded.text[folded.ranges[1].displayStart], '[');
  assert.equal(foldJson(text, ranges, new Set()).text, text);
  assert.equal(foldJson(text, ranges, new Set([ranges[0].start])).text, '{ … }');
});

test('replaces a collapsed subtree preserving every unrelated byte and numeric lexeme', () => {
  const text = ' { "id":9007199254740993123, "items" : [ { "a":1 } ], "tail":1.00e+40 } ';
  const range = jsonContainers(text)[1];
  const replacement = '[{"other":9007199254740993999,"exponent":2.00e+40}]';
  assert.equal(replaceJsonContainer(text, range, replacement), ' { "id":9007199254740993123, "items" : ' + replacement + ', "tail":1.00e+40 } ');
  assert.equal(replaceJsonContainer(text, range, text.slice(range.start, range.end)), text);
  assert.throws(() => replaceJsonContainer(text, range, '[invalid]'));
  assert.throws(() => replaceJsonContainer(text, range, '  '));
});

test('folding huge values still produces bounded syntax-highlighted pages', () => {
  const text = prepareJson({ before: Array.from({ length: 400 }, () => ({ id: 1 })), large: 'x'.repeat(140000), after: [{}] }).text;
  const ranges = jsonContainers(text);
  const folded = foldJson(text, ranges, new Set([ranges[1].start]));
  let offset = 0;
  let all = '';
  while (offset < folded.text.length) {
    const page = jsonPage(folded.text, offset);
    assert.ok(page.text.length <= 65536);
    assert.ok((page.text.match(/\n/g) ?? []).length <= 200);
    assert.equal(jsonHighlights(folded.text, page.start, page.end).map(token => token.text).join(''), page.text);
    all += page.text;
    offset = page.end;
  }
  assert.equal(all, folded.text);
  assert.equal(folded.text[folded.ranges.at(-1).displayStart], '{');
});

test('search finds case-insensitive, non-overlapping matches and splits tokens around them', () => {
  const text = '{\n  "Name": "name and NAME"\n}';
  const matches = findMatches(text, 'name');
  assert.deepEqual(matches.map(m => text.slice(m.start, m.end)), ['Name', 'name', 'NAME']);
  assert.deepEqual(findMatches(text, ''), []);
  assert.equal(findMatches('aaaa', 'aa').length, 2);
  assert.equal(findMatches('x'.repeat(50), 'x', 10).length, 10);
  const token = '"name and NAME"';
  const tokenStart = text.indexOf(token);
  assert.deepEqual(splitByMatches(token, tokenStart, matches, 1).map(p => [p.text, p.match]), [['"', null], ['name', 'active'], [' and ', null], ['NAME', 'match'], ['"', null]]);
  assert.deepEqual(splitByMatches('plain', 100, matches, 0).map(p => p.match), [null]);
});

test('page starts reach the page that contains a match offset', () => {
  const text = `${'line\n'.repeat(450)}needle\n`;
  const offset = text.indexOf('needle');
  const starts = pageStartsFor(text, offset);
  const last = starts[starts.length - 1];
  assert.ok(starts.length > 1 && last <= offset && offset < jsonPage(text, last).end);
  assert.deepEqual(pageStartsFor('short', 2), [0]);
});
