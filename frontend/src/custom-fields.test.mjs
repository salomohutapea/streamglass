import test from 'node:test';
import assert from 'node:assert/strict';
import {placeField,orderLike,moveField,moveFieldBy,urlWildcard,changeSource,newField,newLocation,wildcardMatches,locationMatches,pickInto,fieldName,fieldChips,chipText,chipTitle,needsFullValues,prettyValue,fieldsColumnValue,fieldsForTab,stateText} from './custom-fields.mjs';

const found = (patch = {}) => ({id: 'a', name: 'searchId', locations: [{source: 'response', path: '$.searchId'}], values: ['8f3a'], count: 1, state: 'found', limited: false, ...patch});

test('URL wildcards drop the query and escape fnmatch metacharacters', () => {
  assert.equal(urlWildcard('https://api.example.test/v2/flight/search?x=1#top'), 'https://api.example.test/v2/flight/search*');
  assert.equal(urlWildcard('https://api.example.test/a[1]/b*c'), 'https://api.example.test/a[[]1[]]/b[*]c*');
  assert.equal(urlWildcard('not a url?q'), 'not a url*');
});

test('changing source keeps only a path that fits the new kind', () => {
  const location = newLocation({path: '$.data.searchId'});
  assert.equal(changeSource(location, 'event').path, '$.data.searchId');
  assert.equal(changeSource(location, 'responseHeader').path, '');
  assert.equal(changeSource({...location, source: 'requestHeader', path: 'x-request-id'}, 'requestHeader').path, 'x-request-id');
  assert.equal(changeSource({...location, source: 'requestHeader', path: 'x-request-id'}, 'request').path, '$.');
});

test('field names default to the last path step', () => {
  assert.equal(fieldName('$.data.journeys[0].journeyIndex'), 'journeyIndex');
  assert.equal(fieldName('$["a.b"]'), 'a.b');
  assert.equal(fieldName('x-request-id'), 'x-request-id');
  assert.equal(fieldName('$'), 'New field');
});

test('chips show found fields only, with a count of further distinct values', () => {
  const fields = [found(), found({id: 'b', name: 'journeyIndex', values: ['0', '1'], count: 2}), found({id: 'c', name: 'gone', values: [], count: 0, state: 'missing'}), found({id: 'd', name: 'many', values: ['1', '2', '3', '4', '5'], count: 5, limited: true})];
  assert.deepEqual(fieldChips(fields).map(chipText), ['searchId=8f3a', 'journeyIndex=0 +1', 'many=1 +4+']);
  assert.equal(fieldsColumnValue(fields), 'searchId=8f3a journeyIndex=0 +1 many=1 +4+');
  assert.equal(fieldsColumnValue([]), undefined);
  assert.equal(fieldsColumnValue(undefined), undefined);
});

test('inspector tabs show the fields read from their content', () => {
  const fields = [found(), found({id: 'h', locations: [{source: 'requestHeader', path: 'x-id'}]}), found({id: 'e', locations: [{source: 'event', path: '$.a'}, {source: 'response', path: '$.b'}]})];
  assert.deepEqual(fieldsForTab(fields, 'overview').map(f => f.id), ['a', 'h', 'e']);
  assert.deepEqual(fieldsForTab(fields, 'request').map(f => f.id), ['h']);
  assert.deepEqual(fieldsForTab(fields, 'response').map(f => f.id), ['a', 'e']);
  assert.deepEqual(fieldsForTab(fields, 'events').map(f => f.id), ['e']);
});

test('state text explains values that are not shown', () => {
  assert.equal(stateText(found({state: 'pending'})), 'Waiting for content');
  assert.equal(stateText(found({state: 'unknown', note: 'Response body is not JSON'})), 'Response body is not JSON');
  assert.equal(stateText(found({state: 'missing'})), 'Not found');
  assert.equal(stateText(found()), '');
});

test('arrays and objects show as summaries in chips, with the value in the title', () => {
  const field = found({name: 'passengers', values: ['[{"type":"ADULT"},{"type":"CHILD"}]'], summaries: ['[2 items]']});
  const [chip] = fieldChips([field]);
  assert.equal(chipText(chip), 'passengers=[2 items]');
  assert.equal(chipTitle(chip), 'passengers=[{"type":"ADULT"},{"type":"CHILD"}]');
  assert.equal(chipText(fieldChips([found({summaries: [null]})])[0]), 'searchId=8f3a');
});

test('full values are fetched only for containers or cut values', () => {
  assert.equal(needsFullValues([found()]), false);
  assert.equal(needsFullValues([found({summaries: [null]})]), false);
  assert.equal(needsFullValues([found({summaries: ['{2 keys}']})]), true);
  assert.equal(needsFullValues([found({limited: true})]), true);
  assert.equal(needsFullValues([found({state: 'unknown', limited: true, values: []})]), false);
});

test('pretty values only for complete JSON containers', () => {
  assert.equal(prettyValue('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyValue('{"a":'), null);
  assert.equal(prettyValue('42'), null);
  assert.equal(prettyValue('null'), null);
});

test('wildcards follow fnmatch, including the escapes urlWildcard writes', () => {
  assert.equal(wildcardMatches('https://api.example.test/v2/search*', 'https://api.example.test/v2/search/poll?x=1'), true);
  assert.equal(wildcardMatches('https://api.example.test/v2/search*', 'https://other.test/v2/search'), false);
  assert.equal(wildcardMatches(urlWildcard('https://h.test/a[1]?q'), 'https://h.test/a[1]'), true);
  assert.equal(wildcardMatches('a.c', 'abc'), false);
  assert.equal(wildcardMatches('a[!b]c', 'axc'), true);
  assert.equal(locationMatches({pattern: '*', method: 'post', source: 'response', path: '$'}, {url: 'x', method: 'POST'}), true);
  assert.equal(locationMatches({pattern: '*', method: 'GET', source: 'response', path: '$'}, {url: 'x', method: 'POST'}), false);
});

test('picking fills the active location for its API, or adds a location for another API', () => {
  const poll = {url: 'https://api.example.test/v2/search/poll?id=1', method: 'POST'}, stream = {url: 'https://api.example.test/v2/stream', method: 'POST'};
  const first = pickInto(newField(), 0, poll, 'response', '$.data.searchId');
  assert.equal(first.field.name, 'searchId');
  assert.deepEqual(first.field.locations, [{pattern: 'https://api.example.test/v2/search/poll*', method: 'POST', source: 'response', path: '$.data.searchId'}]);
  assert.equal(first.added, false);
  const refined = pickInto(first.field, 0, poll, 'response', '$.searchId');
  assert.equal(refined.field.locations.length, 1);
  assert.equal(refined.field.locations[0].path, '$.searchId');
  const second = pickInto(refined.field, 0, stream, 'event', '$.searchId');
  assert.equal(second.added, true);
  assert.equal(second.index, 1);
  assert.deepEqual(second.field.locations[1], {pattern: 'https://api.example.test/v2/stream*', method: 'POST', source: 'event', path: '$.searchId'});
  const renamed = {...second.field, name: 'Search ID'};
  assert.equal(pickInto(renamed, 1, stream, 'event', '$.id').field.name, 'Search ID');
  const full = {...renamed, locations: Array.from({length: 10}, () => newLocation({pattern: 'https://elsewhere.test/*'}))};
  assert.equal(pickInto(full, 0, stream, 'event', '$.id'), null);
});

test('fields move before or after another field, or one step with the keyboard', () => {
  const fields = ['a', 'b', 'c', 'd'].map(id => ({id}));
  const ids = list => list.map(field => field.id).join('');
  assert.equal(ids(moveField(fields, 'a', 'c', true)), 'bcad');
  assert.equal(ids(moveField(fields, 'd', 'a', false)), 'dabc');
  assert.equal(ids(moveField(fields, 'b', 'b', true)), 'abcd');
  assert.equal(ids(moveField(fields, 'x', 'a', true)), 'abcd');
  assert.equal(ids(moveFieldBy(fields, 'b', 1)), 'acbd');
  assert.equal(ids(moveFieldBy(fields, 'b', -1)), 'bacd');
  assert.equal(ids(moveFieldBy(fields, 'a', -1)), 'abcd');
  assert.equal(ids(moveFieldBy(fields, 'd', 1)), 'abcd');
});

test('per-field saves keep fields changed elsewhere and the local position', () => {
  const ids = list => list.map(field => field.id + (field.v ?? '')).join(' ');
  const server = [{id: 'a'}, {id: 'b'}, {id: 'x'}], local = [{id: 'a'}, {id: 'n'}, {id: 'b'}];
  assert.equal(ids(placeField(server, local, {id: 'n'})), 'a n b x');
  assert.equal(ids(placeField(server, local, {id: 'b', v: 2})), 'a b2 x');
  assert.equal(ids(placeField(server, [{id: 'n'}, ...local], {id: 'n'})), 'n a b x');
  assert.equal(ids(placeField(server, [], {id: 'n'})), 'a b x n');
  assert.equal(ids(orderLike(server, [{id: 'b'}, {id: 'a'}])), 'b a x');
  assert.equal(ids(orderLike([{id: 'x'}, {id: 'a'}, {id: 'b'}], [{id: 'b'}, {id: 'a'}])), 'b a x');
});
