import test from 'node:test';
import assert from 'node:assert/strict';
import {viewMatches,matchingViewId,describeView} from './saved-filters.mjs';

const base = {filter: 'search', scope: 'url', mode: 'contains', protocols: ['HTTPS'], statuses: [2], device: 'all', application: null, library: 'all'};

test('a saved filter matches only identical traffic filters, ignoring order and empty conditions', () => {
  assert.equal(viewMatches(base, {...base, conditions: []}), true);
  assert.equal(viewMatches({...base, protocols: ['HTTPS', 'SSE']}, {...base, protocols: ['SSE', 'HTTPS']}), true);
  assert.equal(viewMatches(base, {...base, filter: 'searc'}), false);
  assert.equal(viewMatches(base, {...base, statuses: [2, 5]}), false);
  assert.equal(viewMatches(base, {...base, conditions: [{joiner: 'and', scope: 'response', mode: 'contains', filter: 'x'}]}), false);
  assert.equal(viewMatches(base, null), false);
});

test('the dropdown keeps the applied filter among identical ones and clears when filters change', () => {
  const views = [{...base, id: 'one'}, {...base, id: 'two'}, {...base, id: 'sse', library: 'sse'}];
  assert.equal(matchingViewId(views, base, 'two'), 'two');
  assert.equal(matchingViewId(views, base, ''), 'one');
  assert.equal(matchingViewId(views, {...base, library: 'sse'}, 'two'), 'sse');
  assert.equal(matchingViewId(views, {...base, filter: 'other'}, 'two'), '');
});

test('filters are described in words', () => {
  assert.equal(describeView(base), 'url contains "search" · HTTPS · 2xx');
  assert.equal(describeView({...base, filter: '', protocols: [], statuses: [4, 5], library: 'sse', device: 'pixel', application: 'Synthetic', conditions: [{joiner: 'or', scope: 'event', mode: 'equals', filter: 'x'}]}), 'any content · +1 condition · 4xx, 5xx · SSE only · device pixel · app Synthetic');
  assert.equal(describeView({...base, mode: 'not_contains'}), `url doesn't contain "search" · HTTPS · 2xx`);
});
