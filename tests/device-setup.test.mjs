import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseAdbDevices, parseGetprop, classifyAndroid, metroStatus, probeMetro, subjectHashOld, endpointHost } from '../electron/device-inventory.mjs';
import { createDeviceSetup, systemCaScript } from '../electron/device-setup.mjs';
import { parseMdns } from '../electron/adb-pairing.mjs';

const props = (values = {}) => Object.entries({ 'ro.product.model': 'Example Phone', 'ro.build.version.sdk': '35', 'ro.build.version.release': '15', 'ro.build.type': 'userdebug', 'ro.debuggable': '1', 'ro.product.name': 'sdk_gphone64_arm64', ...values }).map(([k,v]) => `[${k}]: [${v}]`).join('\n');
const fixtures = [
  { serial: 'emulator-5554', image: 'google_apis', transport: 'emulator', rootable: true, properties: {} },
  { serial: 'emulator-5556', image: 'google_play', transport: 'emulator', rootable: false, properties: { 'ro.product.name': 'sdk_gphone64_arm64', 'ro.build.flavor': 'sdk_gphone64_arm64-user', 'ro.build.version.sdk': '36', 'ro.build.type': 'user', 'ro.debuggable': '0' } },
  { serial: 'R5CT1234ABC', image: 'unknown', transport: 'usb', rootable: false, properties: { 'ro.product.name': 'example', 'ro.build.type': 'user', 'ro.debuggable': '0' } },
  { serial: 'adb-example._adb-tls-connect._tcp', image: 'unknown', transport: 'wifi', rootable: false, properties: { 'ro.product.name': 'example', 'ro.build.type': 'user', 'ro.debuggable': '0' } },
];
test('adb long listing parses only safe serials and known states', () => {
  const rows = parseAdbDevices('List of devices attached\nemulator-5554 device product:sdk model:Example_Phone transport_id:1\nR5CT1234ABC unauthorized usb:1\n192.168.1.20:37001 offline\nbad;serial device\n');
  assert.deepEqual(rows.map(d => [d.serial,d.state]), [['emulator-5554','device'],['R5CT1234ABC','unauthorized'],['192.168.1.20:37001','offline']]);
  assert.equal(rows[0].model, 'Example Phone');
});
for (const fixture of fixtures) test(`getprop classification: ${fixture.image} ${fixture.transport}`, () => {
  const device = classifyAndroid({ serial: fixture.serial, state: 'device' }, parseGetprop(props(fixture.properties)), 'Example AVD');
  assert.equal(device.image, fixture.image); assert.equal(device.transport, fixture.transport); assert.equal(device.rootable, fixture.rootable);
  assert.equal(device.apiLevel, Number(fixture.properties['ro.build.version.sdk'] || 35));
});
test('qemu properties and address serial identify emulators and Wi-Fi', () => {
  assert.equal(classifyAndroid({ serial: 'example' }, { 'ro.boot.qemu': '1' }).kind, 'emulator');
  assert.equal(classifyAndroid({ serial: '192.168.1.20:37001' }).transport, 'wifi');
});
test('Metro requires exact status and bounded fetch', async () => {
  assert.equal(metroStatus('packager-status:running\n'), true); assert.equal(metroStatus('<html>packager-status:running</html>'), false);
  assert.equal(await probeMetro(async (_url, opts) => { assert.ok(opts.signal); return { ok: true, text: async () => 'packager-status:running' }; }), true);
  assert.equal(await probeMetro(async () => { throw new Error('offline'); }), false);
});
let certificate;
async function cert(t, dir) {
  if (!certificate) {
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'synthetic.key'),'-out',path.join(dir,'synthetic.pem'),'-days','1','-subj','/CN=Synthetic Fixture/O=Example'], { stdio: 'ignore' });
    certificate = await readFile(path.join(dir,'synthetic.pem'),'utf8');
  }
  return certificate;
}
test('subject_hash_old matches OpenSSL on a generated synthetic certificate', async t => {
  const dir = await mkdtemp(path.join(tmpdir(),'sg-cert-test-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const pem = await cert(t,dir); await writeFile(path.join(dir,'fixture.pem'),pem);
  const expected = execFileSync('openssl',['x509','-in',path.join(dir,'fixture.pem'),'-subject_hash_old','-noout'],{encoding:'utf8'}).trim();
  assert.equal(subjectHashOld(pem),expected); assert.throws(() => subjectHashOld('PRIVATE KEY'), /Public/);
});
async function fixture(t, deviceFixture = fixtures[0], { lan = true, metro = true, existingReverse = '', api } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(),'sg-device-test-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const certificatePath = path.join(dir,'fixture.pem'); await writeFile(certificatePath,await cert(t,dir));
  const serial = deviceFixture.serial, commands = [], reverses = new Map(), settings = new Map([['http_proxy','previous.example:3128'], ['global_http_proxy_port','0'],['global_http_proxy_exclusion_list','localhost']]);
  if (existingReverse) reverses.set('tcp:8081',existingReverse);
  let state = {}, online = true, macEnabled = false, sim = false, uid = '2000', bootId = 'boot-1', booted = '1', failSystemCa = false;
  const run = async (_file,args) => {
    commands.push(args);
    if (args[0] === 'devices') return online ? `${serial} device model:Example` : '';
    if (args[0] === 'simctl') return args.includes('list') ? JSON.stringify({ devices: { iOS: sim ? [{udid:'ABC-123',name:'Example',state:'Booted'}] : [] } }) : '';
    const a = args.slice(2);
    if (a[0] === 'emu') return 'Example_AVD\nOK';
    if (a[0] === 'root') { if (uid !== '0') reverses.clear(); uid = '0'; return 'restarting adbd as root'; }
    if (a[0] === 'unroot') { uid = '2000'; reverses.clear(); return 'restarting adbd as non root'; }
    if (a[0] === 'reverse') {
      if (a[1] === '--list') return [...reverses].map(([from,to]) => `${serial} ${from} ${to}`).join('\n');
      if (a[1] === '--remove') reverses.delete(a[2]); else if (a[1] === '--no-rebind') { if (reverses.has(a[2])) throw new Error('already bound'); reverses.set(a[2],a[3]); } else reverses.set(a[2],a[3]); return '';
    }
    if (a[0] === 'shell') {
      if (a[1] === 'id') return uid;
      if (a[1] === 'cat' && a[2] === '/proc/sys/kernel/random/boot_id') return bootId;
      if (a[1] === 'getprop' && a[2] === 'sys.boot_completed') return booted;
      if (a[1] === 'sh' && failSystemCa) throw new Error('mount failed');
      if (a[1] === 'getprop') return props({...deviceFixture.properties,...(api ? {'ro.build.version.sdk':String(api)} : {})});
      if (a[1] === 'settings') { if (a[2] === 'get') return settings.get(a[4]) ?? 'null'; if(a[2] === 'delete') settings.delete(a[4]); else settings.set(a[4], a[5].replace(/^'|'$/g,'')); }
    }
    return '';
  };
  let pending = Promise.resolve();
  const service = createDeviceSetup({ dataDir:dir, certificatePath, proxyPort:9090, adbPath:async()=>'/mock/adb', run, optional:async(file,args)=>run(file,args), readState:async()=>structuredClone(state), saveState:async value=>{state=structuredClone(value);}, enqueue:task=>{const result=pending.then(task);pending=result.catch(()=>{});return result;}, performAction:async req=>{macEnabled=req.action==='mac-enable-proxy';return {};}, macMonitorEnabled:async()=>macEnabled, ensureProxyListening:async()=>{}, getLanInfo:async()=>({enabled:lan,address:'192.168.1.20',setupUrl:null}), metroProbe:async()=>metro });
  t.after(()=>service.dispose());
  return {service, commands, settings, reverses, req:{platform:'android',id:serial}, state:()=>state, offline:()=>{online=false;}, online:()=>{online=true;}, reboot:()=>{bootId='boot-2';uid='2000';reverses.clear();}, booting:v=>{booted=v?'0':'1';}, failSystemCa:v=>{failSystemCa=v;}, sim:()=>{sim=true;}, mac:()=>macEnabled};
}
for (const f of fixtures) test(`connect/revert command sequence: ${f.transport} ${f.image}`, async t => {
  const x=await fixture(t,f); const original = new Map(x.settings);
  const result=await x.service.connect(x.req); assert.equal(result.ok,true,result.message);
  assert.equal(result.connection.proxy.value,`${f.transport==='emulator'?'10.0.2.2':f.transport==='usb'?'127.0.0.1':'192.168.1.20'}:9090`);
  assert.equal(result.connection.cert.mode,f.rootable?'system':'user');
  assert.equal(x.reverses.has('tcp:8081'),f.transport!=='wifi'); assert.equal(x.reverses.has('tcp:9090'),f.transport==='usb');
  if(f.rootable){ const script=x.commands.find(a=>a.includes('sh'))?.at(-1); assert.match(script,/nsenter/); assert.match(script,/pidof zygote zygote64/); assert.match(script,/mount -t tmpfs/); }
  else { const file=result.connection.cert.file; assert.match(file,/^streamglass-ca-[0-9a-f]{8}\.crt$/); assert.ok(x.commands.some(a=>a.includes(`/sdcard/Download/${file}`))); assert.equal(x.commands.some(a=>a.some(v=>String(v).endsWith('streamglass-ca.cer'))),false); }
  const before=x.commands.length;
  assert.equal((await x.service.disconnect(x.req)).ok,true); assert.deepEqual(x.settings,original); assert.equal(x.reverses.size,0); assert.deepEqual(x.state(),{});
  const after=x.commands.slice(before);
  if(f.rootable){ assert.ok(after.some(a=>a.includes('rm')&&a.some(v=>/\/data\/local\/tmp\/streamglass-/.test(v)))); assert.ok(after.some(a=>a.includes('unroot'))); }
  else { assert.ok(after.some(a=>a.includes('rm')&&a.some(v=>/^\/sdcard\/Download\/streamglass-ca-[0-9a-f]{8}\.crt$/.test(v)))); assert.equal(after.some(a=>a.includes('unroot')),false); }
});
test('rootable emulator: reverses are created after adb root restarts adbd', async t => {
  const x=await fixture(t,fixtures[0]); assert.equal((await x.service.connect(x.req)).ok,true);
  const root=x.commands.findIndex(a=>a[2]==='root'), reverse=x.commands.findIndex(a=>a[2]==='reverse'&&a[3]==='--no-rebind');
  assert.ok(root>=0 && reverse>root, 'reverse must follow root');
});
test('API 33 uses system overlay without Conscrypt namespace changes', async t=>{
  const x=await fixture(t,fixtures[0],{api:33}); assert.equal((await x.service.connect(x.req)).ok,true);
  const script=x.commands.find(a=>a.includes('sh')).at(-1); assert.match(script,/mount -t tmpfs/); assert.doesNotMatch(script,/nsenter|apex/);
});
test('wifi refuses LAN-disabled setup before device mutations',async t=>{const x=await fixture(t,fixtures[3],{lan:false});assert.match((await x.service.connect(x.req)).message,/Enable LAN/);assert.equal(x.commands.some(a=>a.includes('push')||a.includes('put')),false);});
test('Metro off leaves existing reverses intact and metadata cached',async t=>{
  const x=await fixture(t,fixtures[0],{metro:false,existingReverse:'tcp:8081'});
  await x.service.inventory();await x.service.inventory();assert.equal(x.commands.filter(a=>a.includes('getprop')).length,1);
  const result=await x.service.connect(x.req);assert.equal(result.connection.metro.status,'off');
  await x.service.disconnect(x.req);assert.equal(x.reverses.get('tcp:8081'),'tcp:8081');
});
test('external proxy changes survive disconnect',async t=>{const x=await fixture(t,fixtures[2]);await x.service.connect(x.req);x.settings.set('http_proxy','other.example:9999');await x.service.disconnect(x.req);assert.equal(x.settings.get('http_proxy'),'other.example:9999');});
test('quit restores Android and options persist in profile',async t=>{
  const x=await fixture(t,fixtures[2]);await x.service.setOptions({metroMode:'off',reapply:false});await x.service.connect(x.req);assert.equal((await x.service.prepareQuit()).ok,true);assert.equal(x.settings.get('http_proxy'),'previous.example:3128');
  await assert.rejects(x.service.setOptions({autoConnect:'yes'}),/Invalid/);
});
test('simulator connect uses keychain and existing Mac proxy path',async t=>{const x=await fixture(t);x.sim();assert.equal((await x.service.connect({platform:'ios-simulator',id:'ABC-123'})).ok,true);assert.equal(x.mac(),true);assert.ok(x.commands.some(a=>a.join(' ').includes('simctl keychain ABC-123 add-root-cert')));await x.service.disconnect({platform:'ios-simulator',id:'ABC-123'});assert.equal(x.mac(),false);});
test('mDNS parser filters unrelated services and unsafe endpoints',()=>{assert.deepEqual(parseMdns('streamglass-abc _adb-tls-pairing._tcp. 192.168.1.20:1234\nother _adb-tls-pairing._tcp. bad;:22','_adb-tls-pairing._tcp','streamglass-abc'),[{name:'streamglass-abc',address:'192.168.1.20:1234'}]);});
test('system CA script validates hash and API 34 restores namespace mounts',()=>{assert.throws(()=>systemCaScript('bad;',35));assert.match(systemCaScript('1234abcd',34,true),/nsenter.*umount/s);});
test('existing Metro reverse is preserved when Metro is requested',async t=>{
  const x=await fixture(t,fixtures[0],{existingReverse:'tcp:8081'});assert.equal((await x.service.connect(x.req)).ok,true);await x.service.disconnect(x.req);assert.equal(x.reverses.get('tcp:8081'),'tcp:8081');
});
test('a conflicting reverse is not overwritten',async t=>{
  const x=await fixture(t,fixtures[0],{existingReverse:'tcp:9999'});const result=await x.service.connect(x.req);assert.equal(result.ok,false);assert.match(result.message,/another tool/);await x.service.disconnect(x.req);assert.equal(x.reverses.get('tcp:8081'),'tcp:9999');
});
test('user confirmation and reopen maintain separate proxy and cert states',async t=>{
  const x=await fixture(t,fixtures[2]);await x.service.connect(x.req);const inv=await x.service.confirm(x.req);assert.equal(inv.android[0].connection.cert.status,'ok');assert.equal(inv.android[0].connection.proxy.status,'ok');
  await x.service.reopen(x.req);assert.equal(x.commands.filter(a=>a.includes('push')).length,2);
});
test('revertOnQuit false leaves saved proxy and reverse ownership intact',async t=>{
  const x=await fixture(t,fixtures[2]);await x.service.setOptions({revertOnQuit:false});await x.service.connect(x.req);await x.service.prepareQuit();assert.equal(x.settings.get('http_proxy'),'127.0.0.1:9090');assert.ok(x.state()['android:R5CT1234ABC'].setup);
});

test('reapply reconnects known devices and auto-connect remains opt-in',async t=>{
  const x=await fixture(t,fixtures[2]);await x.service.connect(x.req);const pushes=()=>x.commands.filter(a=>a.includes('push')).length;
  assert.equal(pushes(),1);x.offline();await x.service.reconcile();x.online();await x.service.reconcile();assert.equal(pushes(),2);
  await x.service.setOptions({reapply:false});x.offline();await x.service.reconcile();x.online();await x.service.reconcile();assert.equal(pushes(),2);
});
test('auto-connect connects a newly discovered emulator only when enabled',async t=>{
  const x=await fixture(t);await x.service.reconcile();assert.equal(x.commands.some(a=>a.includes('push')),false);
  x.offline();await x.service.reconcile();await x.service.setOptions({autoConnect:true});x.online();await x.service.reconcile();assert.equal(x.commands.some(a=>a.includes('push')),true);
});
test('generated system CA scripts parse as POSIX shell without executing commands',()=>{
  for(const api of [33,35]) for(const revert of [false,true]) execFileSync('/bin/sh',['-n'],{input:systemCaScript('1234abcd',api,revert)});
});

test('system CA overlay is not world writable',()=>{
  const script=systemCaScript('1234abcd',35);assert.match(script,/mount -t tmpfs -o mode=0755/);assert.match(script,/chmod 755 \/system\/etc\/security\/cacerts/);
});

test('physical phones on debuggable builds never qualify for a system CA', () => {
  const props = { 'ro.product.name': 'example', 'ro.build.type': 'userdebug', 'ro.debuggable': '1', 'ro.build.version.sdk': '35' };
  assert.equal(classifyAndroid({ serial: 'R5CT1234ABC', state: 'device' }, props).rootable, false);
  assert.equal(classifyAndroid({ serial: '192.168.1.42:37115', state: 'device' }, props).rootable, false);
});

test('wireless-debugging endpoints expose their LAN address', () => {
  assert.equal(endpointHost('192.168.1.42:37115'), '192.168.1.42');
  assert.equal(endpointHost('[fe80::1]:37115'), 'fe80::1');
  assert.equal(endpointHost('adb-R5CT1234ABC-a1b2c3._adb-tls-connect._tcp'), null);
  assert.equal(endpointHost('emulator-5554'), null);
  const wifi = classifyAndroid({ serial: '192.168.1.42:37115', state: 'device' }, {});
  assert.equal(wifi.transport, 'wifi');
  assert.equal(wifi.address, '192.168.1.42');
});

test('revert after a reboot skips cleared mounts, re-roots for cleanup and unroots', async t => {
  const x=await fixture(t,fixtures[0]); assert.equal((await x.service.connect(x.req)).ok,true);
  x.reboot(); const before=x.commands.length;
  assert.equal((await x.service.disconnect(x.req)).ok,true);
  const after=x.commands.slice(before);
  assert.equal(after.some(a=>a.includes('sh')&&/umount/.test(a.at(-1))),false,'mounts are already gone after reboot');
  const root=after.findIndex(a=>a[2]==='root'), rm=after.findIndex(a=>a.includes('rm')), unroot=after.findIndex(a=>a[2]==='unroot');
  assert.ok(root>=0 && rm>root && unroot>rm); assert.deepEqual(x.state(),{});
});
test('reboot reapply waits for boot completion and retries a failed connect', async t => {
  const x=await fixture(t,fixtures[0]); assert.equal((await x.service.connect(x.req)).ok,true);
  x.offline(); await x.service.reconcile(); // device gone
  x.reboot(); x.online(); x.booting(true);
  const count=()=>x.commands.filter(a=>a[2]==='push'&&String(a.at(-1)).startsWith('/data/local/tmp/')).length, pushed=count();
  await x.service.reconcile(); assert.equal(count(),pushed,'no reapply before sys.boot_completed');
  x.booting(false); x.failSystemCa(true); await x.service.reconcile(); assert.equal(count(),pushed+1,'first attempt');
  x.failSystemCa(false); await x.service.reconcile(); assert.equal(count(),pushed+2,'retried after failure');
  assert.ok(x.reverses.has('tcp:8081')); await x.service.reconcile(); assert.equal(count(),pushed+2,'no further reapply once it succeeded');
});
test('system CA script is idempotent on the same boot', () => {
  const script = systemCaScript('c8750f0d', 35);
  const guard = script.indexOf("if ! grep -q 'streamglass-ca-c8750f0d /system/etc/security/cacerts '"), copy = script.indexOf('cp -a /apex/com.android.conscrypt/cacerts/.');
  assert.ok(guard >= 0 && copy > guard, 'APEX copy only before the first mount');
  assert.equal((script.match(/mount -t tmpfs/g) || []).length, 1);
});
test('a reapply queued before Revert does not reconnect afterwards', async t => {
  const x=await fixture(t,fixtures[0]); assert.equal((await x.service.connect(x.req)).ok,true);
  x.offline(); await x.service.reconcile(); x.reboot(); x.online();
  const tick = x.service.reconcile(); const revert = x.service.disconnect(x.req);
  await Promise.all([tick, revert]); await x.service.reconcile();
  assert.deepEqual(x.state(), {}); assert.equal(x.settings.get('http_proxy'), 'previous.example:3128'); assert.equal(x.reverses.size, 0);
});
