import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {registerTools} from '../electron/mcp-tools.mjs';

test('daily MCP tools require confirmed bounded sends and preserve read-only archive access',async t=>{
  const previous=globalThis.fetch,requests=[];
  globalThis.fetch=async(url,options)=>{const path=new URL(url).pathname;requests.push({path,method:options.method,body:options.body&&JSON.parse(options.body)});
    const value=path==='/api/replay-jobs'&&options.method==='GET'?{jobs:Array.from({length:3},(_,index)=>({id:`job-${index}`,state:'complete'}))}:{id:'job',state:'running'};
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});};
  t.after(()=>{globalThis.fetch=previous;});
  const tools=new Map();registerTools({registerTool(name,config,handler){tools.set(name,{config,handler});}},{baseUrl:'http://127.0.0.1:47821',token:'fixture-secret'});
  const parse=(name,value)=>z.object(tools.get(name).config.inputSchema).parse(value);
  const params={request:{url:'https://example.test/',method:'POST',headers:[],bodyBase64:''},count:5,intervalMs:1000,timeoutMs:5000,stopOnError:true,confirmSend:true};
  assert.throws(()=>parse('start_replay_job',{...params,confirmSend:false}));
  assert.throws(()=>parse('start_replay_job',{...params,count:101}));
  assert.equal(tools.get('start_replay_job').config.annotations.openWorldHint,true);
  assert.equal(tools.get('get_session_capture').config.annotations.readOnlyHint,true);
  await tools.get('start_replay_job').handler(parse('start_replay_job',params),{});
  assert.equal(requests.at(-1).path,'/api/replay-jobs');
  assert.equal(requests.at(-1).body.confirmSend,true);
  const listed=await tools.get('list_replay_jobs').handler(parse('list_replay_jobs',{limit:2}),{});
  const jobs=JSON.parse(listed.content[0].text);
  assert.deepEqual(jobs.jobs.map(job=>job.id),['job-0','job-1']);
  assert.equal(jobs.nextOffset,2);
  assert.throws(()=>parse('annotate_capture',{recordId:'one',note:'Note',color:'arbitrary-css'}));
});
