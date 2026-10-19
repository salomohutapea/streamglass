import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeReplayText,decodeReplayText,replayHeaders} from './replay-body.mjs';
test('replay text preserves Unicode and rejects binary text conversion',()=>{
  const text='{"destination":"東京 ✈️","id":9007199254740993123}';
  assert.equal(decodeReplayText(encodeReplayText(text)),text);
  assert.throws(()=>decodeReplayText('/w=='));
  assert.throws(()=>encodeReplayText('x'.repeat(8*1024*1024+1)),/8 MiB/);
});
test('editing plain text removes stale compression while binary replay preserves it',()=>{
  const headers=[['Content-Encoding','gzip'],['Content-Length','40'],['Content-Type','application/json']];
  assert.deepEqual(replayHeaders(headers,true),[['Content-Type','application/json']]);
  assert.deepEqual(replayHeaders(headers,false),headers);
  assert.throws(()=>replayHeaders({},true),/pairs/);
});
