import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import net from 'node:net';
import {_electron as electron} from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('daily desktop tools preserve archives and notes, evaluate watches/assertions and own repeated replays', {timeout:120000}, async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'streamglass-daily-'));
  const reservation=net.createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const proxyPort=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const received=[];
  const origin=createServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    received.push({method:request.method,body:Buffer.concat(chunks).toString()});
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({context:{searchId:'synthetic-search'},iteration:received.length}));
  });
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${origin.address().port}/initial`,start=Date.now()/1000-10;
  const body='{"from":"fixture"}';
  const responseBody='{"context":{"searchId":"synthetic-search"},"version":1}';
  const records=[
    {id:'initial',kind:'request',method:'POST',url,device:'synthetic-phone',startedAt:start,endedAt:start+1,state:'complete',statusCode:200,eventCount:0,events:[],
      request:{method:'POST',url,headers:[['Content-Type','application/json']],body,bodyBase64:Buffer.from(body).toString('base64')},
      response:{statusCode:200,headers:[['Content-Type','application/json']],body:responseBody,bodyBase64:Buffer.from(responseBody).toString('base64')}},
    {id:'sse',kind:'request',method:'POST',url:url+'/sse',device:'synthetic-phone',startedAt:start+.5,endedAt:start+2,state:'complete',statusCode:200,isSSE:true,eventCount:2,
      request:{method:'POST',url:url+'/sse',headers:[],body:'{"searchId":"synthetic-search"}',bodyBase64:Buffer.from('{"searchId":"synthetic-search"}').toString('base64')},
      response:{statusCode:200,headers:[['Content-Type','text/event-stream']],body:'',bodyBase64:'',bodyUnavailable:true},
      sseDiagnostics:{headersAt:start+.6,eventCount:2},events:[
        {sequence:1,event:'context',id:'context',data:'{"searchId":"synthetic-search"}',raw:'event: context\ndata: {"searchId":"synthetic-search"}\n\n',receivedAt:start+.7,processedAt:start+.7,forwarded:true},
        {sequence:2,event:'data',id:'data',data:'{"items":[1]}',raw:'event: data\ndata: {"items":[1]}\n\n',receivedAt:start+1,processedAt:start+1,forwarded:true}]},
  ];
  execFileSync(path.join(root,'.venv/bin/python'),['-c',`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);c.execute('CREATE TABLE config (key TEXT PRIMARY KEY,value TEXT NOT NULL)');c.execute('INSERT INTO config VALUES (?,?)',('settings',json.dumps({'proxyPort':int(sys.argv[2])})));c.execute('CREATE TABLE records (id TEXT PRIMARY KEY,started REAL,payload TEXT)')
for r in json.loads(sys.stdin.read()):c.execute('INSERT INTO records VALUES (?,?,?)',(r['id'],r['startedAt'],json.dumps(r)))
c.commit()`,path.join(directory,'captures.sqlite3'),String(proxyPort)],{input:JSON.stringify(records)});
  let app,page,toolsPage,panel;
  try{
    const env={...process.env,STREAMGLASS_MCP_PORT:'0',STREAMGLASS_KEEP_CAPTURES:'1',STREAMGLASS_BUILT_UI:'1',STREAMGLASS_DATA_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
    const executablePath=process.env.STREAMGLASS_TEST_APP;
    app=await electron.launch({...executablePath?{executablePath}:{},args:[...executablePath?[]:[root],`--user-data-dir=${path.join(directory,'chromium')}`],env});
    page=await app.firstWindow();page.setDefaultTimeout(15000);await page.getByRole('dialog',{name:'Welcome tour'}).getByRole('button',{name:'Skip tour'}).click();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const api=(route,method='GET',value)=>page.evaluate(async({route,method,value})=>{
      const connection=await window.streamglass.getBootstrap();
      const response=await fetch(connection.baseUrl+route,{method,headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})});
      const result=await response.json();if(!response.ok)throw Error(result.error?.message??response.statusText);return result;
    },{route,method,value});
    await page.waitForFunction(()=>document.querySelectorAll('.traffic tbody tr').length===2);
    await page.locator('.traffic tbody tr').filter({hasText:'/initial'}).filter({hasNotText:'/sse'}).click();
    async function openTools(){const opened=app.waitForEvent('window');await page.getByRole('button',{name:'Tools',exact:true}).click();toolsPage=await opened;toolsPage.setDefaultTimeout(15000);panel=toolsPage.getByRole('region',{name:'Tools',exact:true});}
    await openTools();
    await panel.getByRole('button',{name:'Watches',exact:true}).click();
    await panel.getByRole('button',{name:'Add watch',exact:true}).click();
    await panel.getByLabel(/^Watch name /).fill('Search ID');
    await panel.getByRole('button',{name:'Save preferences',exact:true}).click();
    await panel.getByText('Preferences saved.',{exact:true}).waitFor();
    await panel.getByLabel('Daily tools capture').selectOption('initial');
    await panel.locator('.daily-tools').getByText('"synthetic-search"',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'Add watch',exact:true}).click();
    await panel.getByLabel(/^Watch name /).last().fill('Draft watch');
    await panel.getByRole('button',{name:'Compare',exact:true}).click();
    await panel.getByRole('button',{name:'Watches',exact:true}).click();
    assert.equal(await panel.getByLabel(/^Watch name /).last().inputValue(),'Draft watch');
    await panel.getByRole('button',{name:'Delete watch Draft watch',exact:true}).click();
    await panel.getByRole('button',{name:'Assertions',exact:true}).click();
    await panel.getByRole('button',{name:'Add assertion',exact:true}).click();
    await panel.getByLabel('Name',{exact:true}).fill('Missing field');
    await panel.getByLabel(/^Assertion check /).selectOption('required-field');
    await panel.getByLabel(/^Assertion source /).selectOption('response');
    await panel.getByLabel('Required JSONPath',{exact:true}).fill('$.missing');
    await panel.getByRole('button',{name:'Save preferences',exact:true}).click();
    await panel.getByText('Required field is missing',{exact:true}).first().waitFor();
    await panel.getByRole('button',{name:'Journeys',exact:true}).click();
    await panel.locator('.journey-group summary').filter({hasText:'synthetic-search'}).waitFor();
    assert.match(await panel.locator('.journey-group summary').innerText(),/2 requests/);
    assert.ok(await panel.locator('.waterfall-track span').first().evaluate(element=>element.getBoundingClientRect().width>0));
    await panel.locator('.waterfall-table tbody tr').filter({hasText:'/sse'}).getByRole('button').click();
    await page.locator('.inspector .request-url').getByText(url+'/sse',{exact:true}).waitFor();
    assert.equal(toolsPage.isClosed(),false,'Selecting a capture must keep Tools open');
    await toolsPage.screenshot({path:'/tmp/streamglass-daily-journeys.png'});
    await panel.getByRole('button',{name:'Sessions',exact:true}).click();
    await panel.getByLabel('Session name',{exact:true}).fill('Synthetic before fix');
    await panel.getByRole('button',{name:'Save current captures',exact:true}).click();
    await panel.getByLabel('Archived capture',{exact:true}).selectOption('initial');
    await panel.getByLabel('Compare archive with live capture').selectOption('initial');
    await panel.getByText('0 differences',{exact:true}).waitFor();
    const exported=path.join(directory,'synthetic.sgsession');
    await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filePath]});},exported);
    await panel.getByRole('button',{name:'Export…',exact:true}).click();
    await panel.getByText('Session exported.',{exact:false}).waitFor();
    assert.equal((await readFile(exported,'utf8')).trim().split('\n').length,3);
    await panel.getByRole('button',{name:'Import session…',exact:true}).click();
    await panel.getByText('Session imported. Live traffic is unchanged.',{exact:true}).waitFor();
    assert.equal((await api('/api/sessions')).sessions.length,2);
    await panel.getByRole('button',{name:'Close tools',exact:true}).click();
    await page.locator('.traffic tbody tr').filter({hasText:'/initial'}).filter({hasNotText:'/sse'}).getByText('failed checks',{exact:false}).waitFor();
    await page.getByRole('textbox',{name:'Filter requests',exact:true}).fill('/initial');
    await openTools();
    await panel.getByRole('button',{name:'Views & notes',exact:true}).click();
    await panel.getByLabel('View name',{exact:true}).fill('Only initial');
    await panel.getByRole('button',{name:'Save current filters',exact:true}).click();
    await panel.getByRole('button',{name:'Only initial',exact:true}).waitFor();
    await panel.getByLabel('Daily tools capture').selectOption('initial');
    await panel.getByLabel('Capture note',{exact:true}).fill('Investigate this synthetic response');
    await panel.getByLabel('Capture highlight',{exact:true}).selectOption('amber');
    await panel.getByRole('button',{name:'Save note and highlight',exact:true}).click();
    await panel.getByText('Note and highlight saved on the capture.',{exact:true}).waitFor();
    assert.deepEqual((await api('/api/records/initial')).annotation,{note:'Investigate this synthetic response',color:'amber'});
    await page.getByRole('textbox',{name:'Filter requests',exact:true}).fill('');
    await panel.getByRole('button',{name:'Only initial',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.search input')?.value==='/initial');
    assert.equal(toolsPage.isClosed(),false,'Applying a view must keep Tools open');
    await panel.getByRole('button',{name:'Close tools',exact:true}).click();
    await page.locator('.traffic tbody tr.row-highlight-amber').waitFor();
    await page.getByRole('textbox',{name:'Filter requests',exact:true}).fill('');
    await page.getByLabel('Saved views',{exact:true}).selectOption({label:'Only initial'});
    assert.equal(await page.getByRole('textbox',{name:'Filter requests',exact:true}).inputValue(),'/initial');
    await openTools();
    await panel.getByRole('button',{name:'Repeat',exact:true}).click();
    await panel.getByRole('listbox',{name:'Repeat capture'}).getByRole('option').filter({hasText:'/initial'}).filter({hasNotText:'/sse'}).getByRole('button').click();
    await panel.getByLabel('Repeat count',{exact:true}).fill('3');
    await panel.getByLabel('Interval after completion (ms)',{exact:true}).fill('0');
    await panel.getByRole('button',{name:'Start 3 requests',exact:true}).click();
    await panel.getByText('complete · 3/3',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('.traffic tbody tr').length>=5);
    assert.deepEqual(received,Array.from({length:3},()=>({method:'POST',body})));
    await panel.getByLabel('Repeat count',{exact:true}).fill('5');
    await panel.getByLabel('Interval after completion (ms)',{exact:true}).fill('5000');
    await panel.getByRole('button',{name:'Start 5 requests',exact:true}).click();
    await panel.getByText('running · 1/5',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'Cancel repeat',exact:true}).click();
    await panel.getByText('cancelled · 1/5',{exact:true}).waitFor();
    assert.equal(received.length,4);
    await panel.getByLabel('Repeat count',{exact:true}).fill('2');
    await panel.getByLabel('Interval after completion (ms)',{exact:true}).fill('1500');
    await panel.getByRole('button',{name:'Start 2 requests',exact:true}).click();
    await panel.getByText('running · 1/2',{exact:true}).waitFor();
    await api('/api/settings','PUT',{proxyEnabled:false});
    await api('/api/settings','PUT',{proxyEnabled:true});
    await panel.getByText('cancelled · 1/2',{exact:true}).waitFor();
    await new Promise(resolve=>setTimeout(resolve,1800));
    assert.equal(received.length,5);
    assert.deepEqual(errors,[]);
  }catch(error){if(page){await page.screenshot({path:'/tmp/streamglass-daily-failure.png'}).catch(()=>{});console.error((await toolsPage?.locator('.lab-window-panel').innerText().catch(()=>'' )??'').slice(0,2200));}throw error;}
  finally{if(app)await app.close();origin.closeAllConnections();await new Promise(resolve=>origin.close(resolve));await rm(directory,{recursive:true,force:true});}
});
