import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Bot, Check, Copy, Laptop, Loader2, MonitorSmartphone, ShieldAlert, Smartphone, TabletSmartphone } from 'lucide-react';
import { encodeQr } from './qr-code.mjs';
import { LanDeviceList, type LanExpiry, type LanRequest } from './SecurityPrompts';
import './connect-device.css';

type Rec = { id: string; clientIsLocal?: boolean };
/** LAN approval state and actions, so a phone can be allowed without leaving the wizard. */
export type LanApproval = { devices: string[]; requests: LanRequest[]; busy: boolean; expiry?: LanExpiry; onDecide(address: string, allow: boolean): void; onRemoveDevice(address: string): void };
const cards: Array<{ key: string; label: string; hint: string; Icon: typeof Laptop }> = [
  { key: 'mac', label: 'This Mac', hint: 'System proxy', Icon: Laptop },
  { key: 'iosSimulator', label: 'iOS Simulator', hint: 'Xcode', Icon: MonitorSmartphone },
  { key: 'iosDevice', label: 'iOS Device', hint: 'iPhone, iPad', Icon: TabletSmartphone },
  { key: 'androidEmulator', label: 'Android Emulator', hint: '10.0.2.2', Icon: Bot },
  { key: 'androidDevice', label: 'Android Device', hint: 'Wi-Fi', Icon: Smartphone },
];
const stepNames = ['Platform', 'Set up', 'Verify'];

export function QrCode({ text, label }: { text: string; label: string }) {
  const qr = useMemo(() => { try { return encodeQr(text); } catch { return null; } }, [text]);
  if (!qr) return null;
  const quiet = 3, side = qr.size + quiet * 2;
  let path = '';
  qr.modules.forEach((row, r) => { let c = 0; while (c < qr.size) { if (!row[c]) { c++; continue; } const start = c; while (c < qr.size && row[c]) c++; path += `M${start + quiet} ${r + quiet}h${c - start}v1h${start - c}z`; } });
  return <svg className="qr-code" role="img" aria-label={label} viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges"><rect width={side} height={side} fill="#fff"/><path d={path} fill="#000"/></svg>;
}

async function copyValue(value: string) { try { if (window.streamglass?.copyText) await window.streamglass.copyText(value); else await navigator.clipboard.writeText(value); } catch { /* clipboard unavailable */ } }

type SetupSite = { lanEnabled: boolean; port: number | null; running: boolean; fingerprint?: string | null; error?: string };
const bridge = () => window.streamglass as any;

function PhoneSetup({ platform, ip, port, lanEnabled, section }: { platform: string; ip: string; port: number; lanEnabled: boolean; section: 'qr' | 'reverse' }) {
  const [site, setSite] = useState<SetupSite | null>(null);
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  const [android, setAndroid] = useState<Array<{ id: string; name: string }>>([]);
  const [serial, setSerial] = useState('');
  const [metro, setMetro] = useState(false);
  const [result, setResult] = useState('');
  const isAndroid = platform === 'androidEmulator' || platform === 'androidDevice';
  useEffect(() => {
    let live = true;
    const poll = () => { void bridge()?.setupSite?.().then((value: SetupSite) => { if (live) setSite(value); }).catch(() => {}); };
    poll();
    const timer = setInterval(poll, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [lanEnabled]);
  const refreshAndroid = () => { void bridge()?.listDevices?.().then((inventory: any) => { const list = inventory?.android ?? []; setAndroid(list); setSerial(current => list.some((d: any) => d.id === current) ? current : list[0]?.id ?? ''); }).catch(() => {}); };
  useEffect(() => { if (isAndroid) refreshAndroid(); }, [isAndroid]);
  const host = ip.includes(':') ? `[${ip}]` : ip;
  const setupUrl = ip && site?.running && site.port ? `http://${host}:${site.port}/` : '';
  const pacUrl = setupUrl ? `${setupUrl}proxy.pac` : '';
  const copy = (key: string, value: string) => void copyValue(value).then(() => { setCopied(key); setTimeout(() => setCopied(''), 1500); });
  const enableLan = async () => { setBusy(true); try { setSite(await bridge().setupSite({ enableLan: true })); } catch (error) { setSite({ lanEnabled: false, port: null, running: false, error: error instanceof Error ? error.message : String(error) }); } finally { setBusy(false); } };
  const reverse = async (action: 'android-reverse' | 'android-reverse-remove') => { setBusy(true); setResult(''); try { const response = await bridge().deviceAction({ action, target: serial, metro }); setResult(response?.message ?? 'Done'); } catch (error) { setResult(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  return <>
    {section === 'qr' && <section className="connect-qr" aria-label="Certificate setup page">{setupUrl ? <><QrCode text={setupUrl} label={`QR code for the certificate setup page ${setupUrl}`}/><div><span className="connect-step-label"><i>1</i>Install the certificate</span><p className="connect-qr-help">Scan with the phone camera to open the setup page, then download and trust the certificate. The phone must be on the same network.</p><p className="connect-qr-url"><span className="muted">Certificate page (not the proxy)</span><code>{setupUrl}</code></p>{site?.fingerprint && <p className="muted ca-fingerprint" title="Must match the setup page on the phone">Certificate SHA-256 <code>{site.fingerprint}</code></p>}<div className="inline"><button type="button" onClick={() => copy('url', setupUrl)}>{copied === 'url' ? <Check size={12}/> : <Copy size={12}/>} {copied === 'url' ? 'Copied' : 'Copy URL'}</button><button type="button" title={`Auto proxy for ${host}:${port}: use instead of typing the address`} aria-label="Copy PAC URL" onClick={() => copy('pac', pacUrl)}>{copied === 'pac' ? <Check size={12}/> : <Copy size={12}/>} {copied === 'pac' ? 'Copied' : 'PAC'}</button></div></div></> : <div>{!lanEnabled || site?.lanEnabled === false ? <><p className="muted">QR needs local network access.</p><button type="button" className="primary" disabled={busy} onClick={() => void enableLan()}>Turn on local network</button></> : !ip ? <p className="muted">No LAN address. Join a network.</p> : <p className="muted">{site?.error || 'Starting…'}</p>}</div>}</section>}
    {section === 'reverse' && isAndroid && <section className="connect-reverse" aria-label="adb reverse">
      <h4 title={`USB tunnel. Set the device proxy to 127.0.0.1:${port}. Metro uses localhost:8081.`}>adb reverse</h4>
      {android.length ? <div className="inline"><label>Device<select value={serial} onChange={e => setSerial(e.target.value)}>{android.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label><label className="inline"><input type="checkbox" checked={metro} onChange={e => setMetro(e.target.checked)}/> Metro 8081</label><button type="button" disabled={busy || !serial || !bridge()} onClick={() => void reverse('android-reverse')}>Reverse</button><button type="button" disabled={busy || !serial || !bridge()} onClick={() => void reverse('android-reverse-remove')}>Remove</button></div> : <p className="muted">No adb device.</p>}
      <button type="button" onClick={refreshAndroid}>Refresh</button>
      {result && <pre className="setup-output">{result}</pre>}
    </section>}
  </>;
}

export default function ConnectDevice({ initialStep, onDone, platform, onPlatform, lanAddresses, port, lanEnabled, records, details, lan }: { initialStep?: number; onDone: () => void; platform: string; onPlatform: (key: string) => void; lanAddresses: string[]; port: number; lanEnabled: boolean; records: Rec[]; details: ReactNode; lan?: LanApproval }) {
  const [step, setStep] = useState(initialStep ?? 1);
  const [baseline, setBaseline] = useState<Set<string> | null>(null);
  const local = platform === 'mac' || platform === 'iosSimulator';
  const physical = platform === 'iosDevice' || platform === 'androidDevice';
  const ip = lanAddresses[0] ?? '';
  // Phones on Wi-Fi are refused until approved; emulators and adb reverse arrive over loopback and never are.
  const approval = physical && lanEnabled ? lan : undefined;
  const asking = approval?.requests.filter(item => !item.denied).sort((a, b) => a.firstSeen - b.firstSeen) ?? [];
  const arrived = baseline ? records.some(r => !baseline.has(r.id) && (local || !r.clientIsLocal)) : false;
  const go = (next: number) => { setStep(next); setBaseline(next === 3 ? new Set(records.map(r => r.id)) : null); };
  return <div className="connect-device">
    <ol className="connect-steps" aria-label="Connection steps">{stepNames.map((name, i) => <li key={name} className={step === i + 1 ? 'current' : step > i + 1 ? 'done' : ''} aria-current={step === i + 1 ? 'step' : undefined}><button type="button" onClick={() => go(i + 1)} aria-label={`Go to step ${i + 1}: ${name}`}><span>{step > i + 1 ? <Check size={11}/> : i + 1}</span>{name}</button></li>)}</ol>
    {step === 1 && <div className="connect-cards" role="radiogroup" aria-label="Platform">{cards.map(({ key, label, hint, Icon }) => <button key={key} type="button" role="radio" aria-checked={platform === key} className={platform === key ? 'connect-card selected' : 'connect-card'} onClick={() => { onPlatform(key); go(2); }}><Icon size={22}/><strong>{label}</strong><small>{hint}</small></button>)}</div>}
    {step === 2 && <div className="form connect-body"><h3>{cards.find(c => c.key === platform)?.label}</h3>{!local && <PhoneSetup section="qr" platform={platform} ip={ip} port={port} lanEnabled={lanEnabled}/>}{details}{platform === 'iosDevice' && <p className="setup-step-required" role="note"><strong>After installing:</strong> Settings → General → About → Certificate Trust Settings → trust Streamglass.</p>}{approval && <section className="connect-approval" aria-label="Approved devices"><h4><ShieldAlert size={13} aria-hidden="true"/>Approved devices</h4><p className="muted">A new phone is refused until you allow it here. Allow only your own test device.{approval.expiry?.enabled ? ' Approvals last 7 days.' : ''}</p><LanDeviceList devices={approval.devices} requests={approval.requests} busy={approval.busy} expiry={approval.expiry} onRemoveDevice={approval.onRemoveDevice} onDecide={approval.onDecide}/></section>}{!local && <PhoneSetup section="reverse" platform={platform} ip={ip} port={port} lanEnabled={lanEnabled}/>}</div>}
    {step === 3 && <div className="connect-wait" role="status" aria-live="polite">{!arrived && approval && asking[0] ? <div className="connect-asking"><Smartphone size={22} aria-hidden="true"/><strong><span className="mono">{asking[0].address}</span> is trying to connect</strong><p className="muted">It is refused until you allow it. Allow only your own test device.{asking.length > 1 ? ` +${asking.length - 1} more waiting.` : ''}</p><div className="inline"><button type="button" disabled={approval.busy} onClick={() => approval.onDecide(asking[0].address, false)}>Deny</button><button type="button" className="primary" disabled={approval.busy} onClick={() => approval.onDecide(asking[0].address, true)}>Allow device</button></div></div> : arrived ? <><span className="connect-ok"><Check size={22}/></span><strong>Connected</strong></> : <><Loader2 className="spin" size={22}/><strong>Waiting for a request…</strong><p className="muted">{cards.find(c => c.key === platform)?.label}</p><p className="muted connect-hint">{approval ? 'Open an app or page on the device. A new phone asks for approval here first.' : 'Open an app or page on the device.'} Paused capture, certificate pinning or a missing proxy setting can hide requests.</p></>}</div>}
    <div className="connect-nav"><button type="button" disabled={step === 1} onClick={() => go(step - 1)}>Back</button><div><button type="button" className={step === 3 ? 'primary' : ''} onClick={onDone}>Done</button>{step < 3 && <button type="button" className="primary" onClick={() => go(step + 1)}>Next</button>}</div></div>
  </div>;
}
