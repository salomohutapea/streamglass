import { useEffect, useRef, useState } from 'react';
import { Bot, HardDrive, ShieldAlert, Smartphone, X } from 'lucide-react';
import './security-prompts.css';

export type Approval = { id: string; kind: string; title: string; detail: string[]; requestedAt: number; expiresAt: number };
export type LanRequest = { address: string; firstSeen: number; lastSeen: number; attempts: number; denied?: boolean };

type ApprovalBridge = {
  getApprovals?(): Promise<Approval[]>;
  resolveApproval?(input: { id: string; allow: boolean }): Promise<void>;
  onApprovals?(callback: (list: Approval[]) => void): () => void;
};
const bridge = () => (window as unknown as { streamglass?: ApprovalBridge }).streamglass;

const kindLabels: Record<string, string> = { send: 'Sends a request', redirect: 'Redirects traffic', unlock: 'Unlocks HTTPS sites', script: 'Runs JavaScript', workspace: 'Replaces configuration' };

/** One AI (MCP) request at a time; Deny is the default action, and an unanswered request is refused by the app. */
export function AiApprovalPrompt() {
  const [queue, setQueue] = useState<Approval[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const current = queue[0];
  useEffect(() => {
    const api = bridge();
    void api?.getApprovals?.().then(setQueue).catch(() => {});
    return api?.onApprovals?.(setQueue);
  }, []);
  useEffect(() => {
    if (!current) return;
    setNow(Date.now());
    if (!dialog.current?.open) dialog.current?.showModal();
    deny.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [current?.id]);
  if (!current) return null;
  const decide = async (allow: boolean) => {
    setBusy(true);
    try { await bridge()?.resolveApproval?.({ id: current.id, allow }); }
    finally { setBusy(false); }
  };
  const seconds = Math.max(0, Math.floor((current.expiresAt - now) / 1000));
  return <dialog ref={dialog} className="approval-dialog" aria-label="AI assistant request" onCancel={event => { event.preventDefault(); void decide(false); }}>
    <div className="approval-head"><Bot aria-hidden="true"/><div><span className="approval-kind">{kindLabels[current.kind] ?? 'Needs approval'}</span><h2>{current.title}</h2></div></div>
    <div className="approval-body">
      <p className="approval-warn"><Bot size={12} aria-hidden="true"/>Your AI assistant (MCP client) asked for this. Allow only if you did.</p>
      <ul className="approval-detail">{current.detail.map((line, index) => <li key={index} className={line.includes('\n') ? 'code' : ''}>{line}</li>)}</ul>
      {queue.length > 1 && <p className="muted">+{queue.length - 1} waiting</p>}
    </div>
    <div className="approval-foot"><span className="muted" role="timer">Auto-deny in {seconds}s</span><button ref={deny} disabled={busy} onClick={() => void decide(false)}>Deny</button><button className="primary" disabled={busy} onClick={() => void decide(true)}>Allow</button></div>
  </dialog>;
}

/** Devices on the local network that tried to use the proxy before being approved. */
export function LanDeviceRequests({ requests, busy, onDecide }: { requests: LanRequest[]; busy: boolean; onDecide(address: string, allow: boolean): void }) {
  const waiting = requests.filter(item => !item.denied);
  if (!waiting.length) return null;
  return <div className="lan-requests" role="region" aria-label="Device approval requests">{waiting.slice(-3).map(item => <div className="lan-request" key={item.address} role="alert">
    <Smartphone size={14} aria-hidden="true"/><span title={`${item.attempts} connection${item.attempts === 1 ? '' : 's'} refused. Allow only your own test device.`}><strong className="mono">{item.address}</strong> wants to use this proxy</span>
    <button disabled={busy} onClick={() => onDecide(item.address, false)}>Deny</button><button className="primary" disabled={busy} onClick={() => onDecide(item.address, true)}>Allow device</button>
  </div>)}</div>;
}

/** Proxy settings for LAN access: approved devices and private destinations LAN devices may reach. */
export function LanAccessSettings({ devices, requests, destinations, busy, onDestinations, onRemoveDevice, onDecide }: {
  devices: string[]; requests: LanRequest[]; destinations: string; busy: boolean;
  onDestinations(value: string): void; onRemoveDevice(address: string): void; onDecide(address: string, allow: boolean): void;
}) {
  const refused = requests.filter(item => item.denied);
  return <div className="lan-access">
    <div className="setting-summary"><ShieldAlert/><div><strong title="Only these devices can use the proxy over the network. New ones are refused until you allow them.">Approved devices</strong></div></div>
    {devices.length ? <ul className="lan-list">{devices.map(address => <li key={address}><span className="mono">{address}</span><button className="icon-button" aria-label={`Remove device ${address}`} title="Remove device" disabled={busy} onClick={() => onRemoveDevice(address)}><X size={13}/></button></li>)}</ul> : <p className="muted">None yet.</p>}
    {!!refused.length && <><p className="muted">Refused</p><ul className="lan-list">{refused.map(item => <li key={item.address}><span className="mono">{item.address}</span><button disabled={busy} onClick={() => onDecide(item.address, true)}>Allow</button></li>)}</ul></>}
    <label title="Hosts, IPs or CIDR ranges LAN devices may reach. Loopback devices (simulators, adb reverse) are not restricted.">LAN destinations<textarea className="mono" rows={3} value={destinations} placeholder={'staging.example.internal\n10.20.0.0/16'} onChange={event => onDestinations(event.target.value)}/>
      <small>Blocked by default: this Mac, private and VPN ranges. One per line.</small></label>
  </div>;
}

const storageChoices: [number, string][] = [[256, '256 MiB'], [512, '512 MiB'], [1024, '1 GiB (default)'], [2048, '2 GiB'], [4096, '4 GiB']];

/** Size of the retention budget for captures of HTTPS-inspected sites (settings.inspectedStorageMiB). */
export function StorageSettings({ inspectedMiB, onInspectedMiB }: { inspectedMiB: number; onInspectedMiB(value: number): void }) {
  // A 5 MB uncompressed JSON response takes about 12.4 MiB once stored (decoded text plus the original bytes).
  const large = Math.floor(inspectedMiB / 12.4);
  return <div className="form"><h3>Storage</h3>
    <div className="setting-summary"><HardDrive/><div><strong>Inspected HTTPS captures</strong><p>Up to 5000 captures. Oldest unpinned are dropped when full.</p></div></div>
    <label>Keep up to<select value={inspectedMiB} onChange={event => onInspectedMiB(Number(event.target.value))}>{storageChoices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <small title="Captures live in memory and contain secrets. Lowering the limit drops the oldest on save. Other traffic has its own 256 MiB budget.">About {large} large (5 MB) responses</small></label>
  </div>;
}
