import test from 'node:test';
import assert from 'node:assert/strict';
import {groupJourneys,assertionCounts} from './daily-tools.mjs';

test('journey correlation joins aliases within a device and preserves overlap',()=>{
  const records=[{id:'initial',device:'android',startedAt:10,endedAt:12},{id:'sse',device:'android',startedAt:11,endedAt:15},{id:'retry',device:'android',startedAt:14,endedAt:16},{id:'ios',device:'ios',startedAt:10,endedAt:11}];
  const analysis={initial:{correlations:['search']},sse:{correlations:['search','request'],firstDataAt:11.5,firstInventoryAt:12},retry:{correlations:['request']},ios:{correlations:['search']}};
  const groups=groupJourneys(records,analysis,20);
  assert.equal(groups.length,2);
  const android=groups.find(group=>group.device==='android');
  assert.equal(android.records.length,3);
  assert.equal(android.durationMs,6000);
  assert.equal(android.records[1].offsetMs,1000);
  assert.equal(android.records[1].elapsedMs,4000);
  assert.equal(android.firstDataMs,1500);
  assert.equal(android.firstInventoryMs,2000);
});

test('uncorrelated captures remain separate and open requests use observed elapsed time',()=>{
  const groups=groupJourneys([{id:'a',startedAt:10,state:'streaming'},{id:'b',startedAt:11,state:'complete',durationMs:500}],{},12);
  assert.equal(groups.length,2);
  assert.equal(groups.find(group=>group.id==='a').durationMs,2000);
  assert.equal(groups.find(group=>group.id==='b').durationMs,500);
  assert.equal(groups[0].firstInventoryMs,null);
});

test('assertion counters keep unknown distinct from passing',()=>{
  assert.deepEqual(assertionCounts({a:{assertions:[{result:'pass'},{result:'unknown'}]},b:{assertions:[{result:'fail'},{result:'pending'}]}}),{pass:1,fail:1,pending:1,unknown:1});
});
