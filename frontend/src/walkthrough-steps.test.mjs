import test from 'node:test';
import assert from 'node:assert/strict';
import { walkthroughStops, availableStops, unionRect, placeTooltip } from './walkthrough-steps.mjs';

const viewport = { width: 1200, height: 800 }, tip = { width: 300, height: 140 };

test('stops keep their order and skip those with nothing to point at', () => {
  assert.deepEqual(walkthroughStops.map(stop => stop.id), ['capture', 'address', 'devices', 'browse', 'filters', 'table', 'inspector', 'rules', 'more']);
  assert.equal(new Set(walkthroughStops.map(stop => stop.id)).size, walkthroughStops.length);
  const missing = new Set(['.inspector', '#sidebar-devices']);
  // Devices still has its header to point at; the inspector has nothing, so it is skipped.
  assert.deepEqual(availableStops(walkthroughStops, selector => !missing.has(selector)).map(stop => stop.id), ['capture', 'address', 'devices', 'browse', 'filters', 'table', 'rules', 'more']);
  assert.deepEqual(availableStops(walkthroughStops, () => false), []);
});

test('the highlight covers all targets and stays inside the window', () => {
  assert.deepEqual(unionRect([{ left: 10, top: 20, width: 100, height: 30 }, { left: 50, top: 60, width: 200, height: 40 }], viewport), { left: 10, top: 20, width: 240, height: 80 });
  assert.deepEqual(unionRect([{ left: -20, top: -5, width: 2000, height: 900 }], viewport), { left: 4, top: 4, width: 1192, height: 792 });
  assert.equal(unionRect([], viewport), null);
});

test('the tooltip prefers below, falls back by available room, and never leaves the window', () => {
  assert.deepEqual(placeTooltip({ left: 500, top: 10, width: 60, height: 30 }, tip, viewport), { side: 'below', left: 380, top: 52 });
  assert.equal(placeTooltip({ left: 500, top: 740, width: 60, height: 30 }, tip, viewport).side, 'above');
  // A full-height sidebar: no room above or below, so it goes to the right.
  const beside = placeTooltip({ left: 0, top: 46, width: 216, height: 754 }, tip, viewport);
  assert.equal(beside.side, 'right');
  assert.equal(beside.left, 228);
  // A target near the left edge keeps the tooltip on screen.
  assert.equal(placeTooltip({ left: 4, top: 10, width: 30, height: 30 }, tip, viewport).left, 10);
  // A target that fills the window still yields an on-screen position.
  const over = placeTooltip({ left: 4, top: 4, width: 1192, height: 792 }, tip, viewport);
  assert.ok(over.left >= 10 && over.left + tip.width <= viewport.width - 10 && over.top >= 10 && over.top + tip.height <= viewport.height - 10);
});
