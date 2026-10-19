import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportSession, importSession } from '../electron/export-session.mjs';

test('full-session export streams beyond the renderer 64 MiB limit and preserves existing files on failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'streamglass-export-'));
  let fail = false;
  const server = http.createServer(async (request, response) => {
    assert.equal(request.url, '/api/export-all');
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    if (fail === 'truncate') {
      response.setHeader('Content-Length', '1024'); response.write('partial');
      setTimeout(() => response.destroy(), 10); return;
    }
    if (fail) { response.writeHead(500); response.end('failed'); return; }
    response.setHeader('Content-Type', 'application/json');
    response.write('{"records":[{"body":"');
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    for (let i = 0; i < 65; i++) if (!response.write(chunk)) await once(response, 'drain');
    response.end('"}]}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const destination = path.join(directory, 'session.json');
  try {
    await exportSession({ baseUrl, token: 'fixture-token', destination });
    assert.ok((await stat(destination)).size > 64 * 1024 * 1024);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    await writeFile(destination, 'keep-existing');
    fail = true;
    await assert.rejects(exportSession({ baseUrl, token: 'fixture-token', destination }), /HTTP 500/);
    assert.equal(await readFile(destination, 'utf8'), 'keep-existing');
    fail = 'truncate';
    await assert.rejects(exportSession({ baseUrl, token: 'fixture-token', destination }));
    assert.equal(await readFile(destination, 'utf8'), 'keep-existing');
    assert.deepEqual(await readdir(directory), ['session.json']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('saved session files stream through their dedicated import and export endpoints', async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'streamglass-archive-'));
  const wire='{"format":"streamglass-session","version":2,"name":"Synthetic","recordCount":1}\n{"id":"one"}\n';
  let received='';
  const server=http.createServer(async(request,response)=>{
    assert.equal(request.headers.authorization,'Bearer fixture-token');
    if(request.method==='POST'){
      assert.equal(request.url,'/api/sessions/import');
      for await(const chunk of request) received+=chunk;
      response.setHeader('Content-Type','application/json');response.end('{"id":"archive"}');
    }else{assert.equal(request.url,'/api/sessions/archive/export');response.end(wire);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${server.address().port}`,file=path.join(directory,'capture.sgsession');
  try{
    await exportSession({baseUrl,token:'fixture-token',destination:file,sessionId:'archive'});
    assert.equal(await readFile(file,'utf8'),wire);
    assert.deepEqual(await importSession({baseUrl,token:'fixture-token',source:file}),{id:'archive'});
    assert.equal(received,wire);
    await assert.rejects(exportSession({baseUrl,token:'fixture-token',destination:file,sessionId:'../other'}),/Invalid session ID/);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
