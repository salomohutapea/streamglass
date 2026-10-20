import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import { _electron as electron } from 'playwright';
import { setMonacoText } from './monaco-helpers.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('testing tools compare, redact, save mocks, switch workspaces, decode and explicitly replay', {timeout:90000}, async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'streamglass-lab-'));
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const proxyPort=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const received=[];const origin=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);received.push(Buffer.concat(chunks).toString());res.setHeader('content-type','application/json');res.setHeader('x-nonce','fixture-nonce');res.end(req.url.includes('encoded-edit')?Buffer.from('{"before":true}').toString('base64'):'{"ok":true}');});
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${origin.address().port}/echo`;
  const a='{"value":1,"id":9007199254740993123,"token":"PRIVATE-TOKEN"}',b='{"value":2,"id":9007199254740993124,"token":"PRIVATE-TOKEN"}';
  const records=[['a',a],['b',b],['encoded',Buffer.from('{"decoded":true}').toString('base64')]].map(([id,body],index)=>({id,kind:'request',method:'POST',url:id==='encoded'?url+'/encoded':url,startedAt:1792123200+index,state:'complete',device:'test',statusCode:200,request:{method:'POST',url,headers:[['Content-Type','application/json']],body:'{"original":true}',bodyBase64:Buffer.from('{"original":true}').toString('base64')},response:{statusCode:200,headers:[['Content-Type','application/json'],['Authorization','SECRET-HEADER']],body,bodyBase64:Buffer.from(body).toString('base64')},events:[],logs:['PRIVATE-LOG']}));
  execFileSync(path.join(root,'.venv/bin/python'),['-c',`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);c.execute('CREATE TABLE config (key TEXT PRIMARY KEY,value TEXT NOT NULL)');c.execute('INSERT INTO config VALUES (?,?)',('settings',json.dumps({'proxyPort':int(sys.argv[2])})));c.execute('CREATE TABLE records (id TEXT PRIMARY KEY,started REAL,payload TEXT)')
for r in json.loads(sys.stdin.read()):c.execute('INSERT INTO records VALUES (?,?,?)',(r['id'],r['startedAt'],json.dumps(r)))
c.commit()`,path.join(directory,'captures.sqlite3'),String(proxyPort)],{input:JSON.stringify(records)});
  let app, page;
  try{
    const env={...process.env,STREAMGLASS_MCP_PORT:'0',STREAMGLASS_KEEP_CAPTURES:'1',STREAMGLASS_BUILT_UI:'1',STREAMGLASS_DATA_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
    const executablePath=process.env.STREAMGLASS_TEST_APP;
    app=await electron.launch({...executablePath?{executablePath}:{},args:[...executablePath?[]:[root],`--user-data-dir=${path.join(directory,'chromium')}`],env});
    page=await app.firstWindow();page.setDefaultTimeout(12000);await page.getByRole('dialog',{name:'Welcome tour'}).getByRole('button',{name:'Skip tour'}).click();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Renderer error:',e.message);});
    await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===3);
    const toolsOpened=app.waitForEvent('window');await page.getByRole('button',{name:'Tools',exact:true}).click();const toolsPage=await toolsOpened;toolsPage.setDefaultTimeout(12000);const panel=toolsPage.getByRole('region',{name:'Tools',exact:true});
    await panel.getByRole('button',{name:'Compare',exact:true}).click();
    await panel.getByRole('button',{name:'Slot A'}).click();await panel.getByRole('listbox',{name:'Capture A'}).getByRole('option').filter({hasText:/\/echo(?!\/)/}).nth(0).getByRole('button').click();await panel.getByRole('button',{name:'Slot B'}).click();await panel.getByRole('listbox',{name:'Capture B'}).getByRole('option').filter({hasText:/\/echo(?!\/)/}).nth(1).getByRole('button').click();
    await panel.getByText('2 differences',{exact:true}).waitFor();
    await panel.getByLabel('Ignore fields or paths').fill('id');await panel.getByText('1 differences',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'Share',exact:true}).click();await panel.getByRole('listbox',{name:'Capture to share'}).getByRole('option').filter({hasText:/\/echo(?!\/)/}).nth(1).getByRole('button').click();
    assert.doesNotMatch(await panel.innerText(),/PRIVATE-TOKEN|PRIVATE-LOG|SECRET-HEADER/);
    const exported=path.join(directory,'redacted.json');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},exported);
    await panel.getByRole('button',{name:'Export redacted capture'}).click();await panel.getByText('Redacted export prepared.').waitFor();
    const output=await readFile(exported,'utf8');assert.doesNotMatch(output,/PRIVATE-TOKEN|PRIVATE-LOG|SECRET-HEADER|bodyBase64/);assert.match(output,/9007199254740993123/);
    await panel.getByRole('button',{name:'Create mock',exact:true}).click();await panel.getByRole('listbox',{name:'Capture to mock'}).getByRole('option').filter({hasText:/\/echo(?!\/)/}).nth(0).getByRole('button').click();await panel.getByLabel('Mock name').fill('Captured mock');await panel.getByRole('button',{name:'Save capture as mock'}).click();await panel.getByText('Mock saved disabled. Open Map Local to review and enable it.').waitFor();
    await panel.getByRole('button',{name:'Scenarios',exact:true}).click();await panel.getByRole('button',{name:'Add Context events only'}).click();await panel.getByLabel('Name',{exact:true}).fill('Context only');await panel.getByLabel('Enabled',{exact:true}).check();await panel.getByRole('button',{name:'Save scenarios'}).click();await panel.getByRole('status').waitFor();
    await panel.getByRole('button',{name:'Workspaces',exact:true}).click();await panel.getByLabel('Workspace name').fill('Alpha');await panel.getByRole('button',{name:'Save current configuration'}).click();await panel.getByText('Current configuration saved.').waitFor();
    await panel.getByRole('button',{name:'Scenarios',exact:true}).click();await panel.getByLabel('Enabled',{exact:true}).uncheck();await panel.getByRole('button',{name:'Save scenarios'}).click();await panel.getByRole('status').waitFor();
    await panel.getByRole('button',{name:'Workspaces',exact:true}).click();await panel.getByLabel('Workspace name').fill('Beta');await panel.getByRole('button',{name:'Save current configuration'}).click();await panel.getByText('Current configuration saved.').waitFor();
    await panel.getByRole('button',{name:'Switch to Alpha'}).click();await panel.getByText('Workspace loaded. Captures were preserved.').waitFor();
    await panel.getByRole('button',{name:'Scenarios',exact:true}).click();assert.equal(await panel.getByLabel('Enabled',{exact:true}).isChecked(),true);
    await panel.getByRole('button',{name:'Codecs',exact:true}).click();await panel.getByRole('button',{name:'Add codec'}).click();await panel.getByLabel('Name',{exact:true}).fill('Base64 demo');await panel.getByLabel('URL wildcard').fill('*encoded*');await panel.getByLabel('Allow response re-encoding').check();await panel.getByRole('button',{name:'Save codec'}).click();await panel.getByText('Base64 demo · base64 · enabled',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'Replay',exact:true}).click();await panel.getByRole('listbox',{name:'Captures to replay'}).getByRole('option').filter({hasText:/\/echo(?!\/)/}).nth(0).getByRole('button').click();await panel.getByLabel('Destination URL').fill(url);await panel.getByLabel('Request body',{exact:true}).fill('{"edited":"東京"}');assert.equal(received.length,0);
    await panel.getByRole('button',{name:'Send request',exact:true}).click();await panel.getByRole('status').waitFor();
    for(let n=0;n<100&&!received.length;n++)await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(received,['{"edited":"東京"}']);
    await panel.getByRole('button',{name:'Close tools'}).click();
    await page.getByRole('row').filter({hasText:'/encoded'}).click();await page.getByRole('tab',{name:'Response',exact:true}).click();await page.getByRole('button',{name:'Decode response',exact:true}).click();await page.locator('.inspector').getByText('"decoded"',{exact:false}).waitFor();
    await page.evaluate(async()=>{const c=await window.streamglass.getBootstrap();const headers={Authorization:`Bearer ${c.token}`,'Content-Type':'application/json'};const state=await (await fetch(c.baseUrl+'/api/state',{headers})).json();const r=await fetch(c.baseUrl+'/api/rules',{method:'PUT',headers,body:JSON.stringify({revision:state.rulesRevision,rules:[{id:'codec-edit',name:'Codec edit',enabled:true,pattern:'*encoded-edit',method:'GET',stages:['response'],breakpoint:true}]})});if(!r.ok)throw Error(await r.text());});
    const newWindow=app.waitForEvent('window');
    const result=new Promise((resolve,reject)=>{const req=httpRequest({hostname:'127.0.0.1',port:proxyPort,path:url+'/encoded-edit',headers:{Host:new URL(url).host}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({body:Buffer.concat(chunks).toString(),nonce:res.headers['x-nonce']}));});req.on('error',reject);req.end();});
    const editor=await newWindow;editor.setDefaultTimeout(12000);
    await editor.getByRole('button',{name:'Decoded body',exact:true}).click();await setMonacoText(app, editor.getByRole('textbox',{name:'Decoded response body',exact:true}),'{"after":true}');
    await editor.getByRole('button',{name:'Continue',exact:true}).click();const edited=await result;assert.equal(Buffer.from(edited.body,'base64').toString(),'{"after":true}');assert.equal(edited.nonce,'fixture-nonce');
    assert.deepEqual(errors,[]);
  }catch(error){if(page){await page.screenshot({path:'/tmp/streamglass-lab-failure.png'}).catch(()=>{});console.error((await app.windows().find(window=>window.url().includes('editor=tools'))?.locator('.lab-window-panel').innerText().catch(()=>'' )??'').slice(0,1800));}throw error;}finally{if(app)await app.close();await new Promise(resolve=>origin.close(resolve));await rm(directory,{recursive:true,force:true});}
});
