import test from 'node:test';
import assert from 'node:assert/strict';
import { editableBody, resolvedBody } from './editor-draft.mjs';

test('pretty JSON retains exact numeric tokens and untouched wire data', () => {
  const original = '{"id":90071992547409931234,"exponent":1e+30,"text":"a b"}';
  const shown = editableBody(original);
  assert.equal(shown, '{\n  "id": 90071992547409931234,\n  "exponent": 1e+30,\n  "text": "a b"\n}');
  assert.equal(resolvedBody(shown, original), original);
  assert.equal(resolvedBody(shown.replace('a b', 'changed'), original), shown.replace('a b', 'changed'));
});

test('empty and non-JSON bodies remain editable without placeholder text', () => {
  assert.equal(editableBody(''), '');
  assert.equal(editableBody(undefined), '');
  assert.equal(editableBody('data: hello\n'), 'data: hello\n');
  assert.equal(resolvedBody('', undefined), undefined);
});
