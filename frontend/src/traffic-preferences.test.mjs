import test from 'node:test';
import assert from 'node:assert/strict';
import {readColumnWidths,readColumns,matchesLibrary,matchesQuickFilters,recordContentTypes} from './traffic-preferences.mjs';
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

test('content types use MIME metadata, including structured suffixes and case parameters', () => {
 for(const [mime,type] of [['Application/Problem+JSON; charset=utf-8','json'],['text/xml','xml'],['application/xhtml+xml','document'],['text/javascript','js'],['application/x-javascript','js'],['text/css','css'],['application/pdf','document'],['text/plain','document'],['image/svg+xml','media'],['audio/mpeg','media'],['video/mp4','media'],['application/octet-stream','other']]) {
  assert.deepEqual(recordContentTypes({response:{headers:[['Content-Type',mime]]}}),[type]);
 }
 assert.deepEqual(recordContentTypes({responseContentType:'application/json'}),['json']);
 assert.deepEqual(recordContentTypes({request:{headers:{'content-type':'application/json'}}}),['json']);
 assert.deepEqual(recordContentTypes({url:'https://example.test/pretend.json'}),['other']);
});

test('forms compose with their response type; opaque tunnels never have a content type', () => {
 const form={url:'https://example.test/submit',statusCode:201,requestContentType:'multipart/form-data; boundary=example',responseContentType:'application/json'};
 assert.deepEqual(recordContentTypes(form),['json','form']);
 assert.equal(matchesQuickFilters(form,['HTTPS'],[2],['form']),true);
 assert.equal(matchesQuickFilters(form,['HTTPS'],[2],['xml','json']),true);
 assert.equal(matchesQuickFilters(form,['HTTP'],[2],['json']),false);
 assert.equal(matchesQuickFilters(form,[],[4],['json']),false);
 assert.deepEqual(recordContentTypes({kind:'tunnel',responseContentType:'application/json'}),[]);
 assert.equal(matchesQuickFilters({url:'https://example.test',kind:'tunnel'},[],[],['other']),false);
});

test('JSON includes SSE with valid JSON event data, even when a later event is a plain terminator', () => {
 const stream={url:'https://example.test/events',isSSE:true,statusCode:200,responseContentType:'text/event-stream',events:[{data:'heartbeat'},{data:'{"result":[1,2]}'},{data:'[DONE]'}]};
 assert.deepEqual(recordContentTypes(stream),['json']);
 assert.equal(matchesQuickFilters(stream,['SSE'],[2],['json']),true);
 assert.deepEqual(recordContentTypes({...stream,events:undefined,hasJsonEvents:true}),['json']);
 assert.deepEqual(recordContentTypes({...stream,events:[{data:'heartbeat'},{data:'[DONE]'}]}),['other']);
 assert.deepEqual(recordContentTypes({...stream,events:[{data:'{partial'},{data:'NaN'},{data:''}]}),['other']);
 assert.deepEqual(recordContentTypes({...stream,kind:'tunnel',hasJsonEvents:true}),[]);
});
