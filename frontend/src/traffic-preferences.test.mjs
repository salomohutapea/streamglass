import test from 'node:test';
import assert from 'node:assert/strict';
import {readColumnWidths,readColumns,matchesLibrary,matchesQuickFilters} from './traffic-preferences.mjs';
test('column preferences discard unknown properties and retain a usable default',()=>{
 assert.deepEqual(readColumns('["status","status","secret"]'),['status']);
 for(const value of ['[]','{}','bad','["unknown"]',null]) assert.deepEqual(readColumns(value),['method','request','status','duration']);
});
test('Pinned library uses durable record metadata and SSE stays independent',()=>{
 assert.equal(matchesLibrary({pinned:true},'pinned'),true);
 assert.equal(matchesLibrary({},'pinned'),false);
 assert.equal(matchesLibrary({pinned:true},'sse'),false);
 assert.equal(matchesLibrary({state:'streaming'},'sse'),false);
 assert.equal(matchesLibrary({},'all'),true);
 assert.equal(matchesLibrary({response:{headers:[['Content-Type','text/event-stream; charset=utf-8']]}},'sse'),true);
 assert.equal(matchesLibrary({kind:'tunnel',isSSE:true},'sse'),false);
});

test('quick filters OR within each group and AND between groups',()=>{
 const request={url:'https://example.com',statusCode:201,isSSE:true};
 assert.equal(matchesQuickFilters(request,['HTTP','HTTPS'],[2,4]),true);
 assert.equal(matchesQuickFilters(request,['SSE'],[2]),true);
 assert.equal(matchesQuickFilters(request,['HTTPS'],[4]),false);
 assert.equal(matchesQuickFilters(request,['HTTP'],[2]),false);
 assert.equal(matchesQuickFilters({url:'https://example.com',kind:'tunnel'},['HTTPS'],[]),true);
 assert.equal(matchesQuickFilters({url:'http://example.com'},[],[2]),false);
 assert.equal(matchesQuickFilters({url:'http://example.com'},[],[]),true);
 assert.equal(matchesQuickFilters({url:'https://example.com',kind:'tunnel',statusCode:200},[],[2]),false);
 assert.equal(matchesQuickFilters({url:'https://example.com',state:'streaming'},['SSE'],[]),false);
 assert.equal(matchesQuickFilters({url:'https://example.com',response:{headers:{'Content-Type':'text/event-stream'}}},['SSE'],[]),true);
 assert.equal(matchesQuickFilters({url:'https://example.com',response:{headers:[['content-type','text/event-stream']]}},['SSE'],[]),true);
});

test('column widths keep known columns within range', () => {
 assert.deepEqual(readColumnWidths('{"method":90.4,"status":10,"secret":100,"request":"wide","path":2000}'),{method:90});
 assert.deepEqual(readColumnWidths('nope'),{});
 assert.deepEqual(readColumnWidths('[1]'),{});
});
