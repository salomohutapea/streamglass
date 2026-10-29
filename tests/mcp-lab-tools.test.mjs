import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerTools } from '../electron/mcp-tools.mjs';

test('lab MCP tools validate requests, mark remote sends and bound timing data', async t => {
  const previous = globalThis.fetch; const requests = []; let scenarios = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname; const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method: options.method, body });
    let value;
    if (path === '/api/scenarios') { if (body) scenarios = body.rules; value = { rules: scenarios }; }
    else if (path.endsWith('/fixture')) value = { id:'fixture',name:body.name,enabled:false,statusCode:200,bodyBase64:'private bytes' };
    else if (path === '/api/replay') value = {id:'sent'};
    else value = {state:'streaming',eventCount:200,sseDiagnostics:{headersAt:1},events:Array.from({length:150},(_,i)=>({sequence:i+1,data:'private body',raw:'private raw',receivedAt:i+2}))};
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  };
  t.after(() => { globalThis.fetch = previous; });
  const tools = new Map(); registerTools({registerTool(name,config,handler){tools.set(name,{config,handler});}},{baseUrl:'http://127.0.0.1:49871',token:'management-secret',confirm:async()=>true});
  const call = async (name,args={}) => { const tool=tools.get(name); const result=await tool.handler(z.object(tool.config.inputSchema).parse(args),{}); assert.equal(result.isError,undefined); return JSON.parse(result.content[0].text); };
  const rule = {id:'one',name:'Experiment',pattern:'*',method:'GET',enabled:false,action:'context-only'};
  assert.deepEqual(await call('set_scenarios',{rules:[rule]}),{saved:true,count:1});
  assert.equal((await call('get_scenarios')).items.length,1);
  await assert.rejects(call('set_scenarios',{rules:[rule,rule]}));
  await assert.rejects(call('set_scenarios',{rules:[{...rule,delayMs:60001}]}));
  const fixture=await call('create_capture_fixture',{recordId:'capture',name:'Fixture',timedSse:true});
  assert.equal(fixture.enabled,false);assert.equal(fixture.bodyBase64,undefined);
  const replay={url:'https://example.test/',method:'POST',headers:[['X-Test','one'],['X-Test','two']],bodyBase64:'',confirmSend:true};
  await assert.rejects(call('replay_request',{...replay,confirmSend:false}));
  await assert.rejects(call('replay_request',{...replay,url:'file:///tmp/file'}));
  await assert.rejects(call('replay_request',{...replay,headers:[['X-Test','bad\r\nInjected: yes']]}));
  assert.deepEqual(await call('replay_request',replay),{id:'sent'});
  assert.equal(requests.at(-1).body.confirmSend,undefined);assert.deepEqual(requests.at(-1).body.headers,replay.headers);
  assert.equal(tools.get('replay_request').config.annotations.openWorldHint,true);
  assert.equal(tools.get('replay_request').config.annotations.destructiveHint,true);
  const timing=await call('get_sse_diagnostics',{recordId:'capture',limit:10});
  assert.equal(timing.timings.items.length,10);assert.equal(timing.timings.total,150);assert.equal(timing.incomplete,true);
  assert.equal(JSON.stringify(timing).includes('private'),false);
});
