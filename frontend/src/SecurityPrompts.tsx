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

const refusals = (count: number) => `${count} connection${count === 1 ? '' : 's'} refused so far`;
type DeviceNames = { deviceNames?(addresses: string[]): Promise<Record<string, string>>; lanApprovalAttention?(): Promise<void> };
/** Names the Mac already knows for LAN addresses (the same lookup the sidebar uses); empty until resolved. */
function useDeviceNames(addresses: string[]) {
  const [names, setNames] = useState<Record<string, string>>({});
  const key = addresses.join(',');
  useEffect(() => {
    const lookup = (window as unknown as { streamglass?: DeviceNames }).streamglass?.deviceNames;
    if (!key || !lookup) return;
    let live = true;
    void lookup(key.split(',')).then(found => { if (live) setNames(current => ({ ...current, ...found })); }).catch(() => {});
    return () => { live = false; };
  }, [key]);
  return names;
}

/** A device on the local network tried to use the proxy before being approved. One at a time, oldest first; Deny is
 *  the default. Hidden while another dialog is open (`suppressed`): Connect a device shows the request inline instead. */
export function LanDevicePrompt({ requests, busy, suppressed, expiry, onDecide }: { requests: LanRequest[]; busy: boolean; suppressed?: boolean; expiry?: LanExpiry; onDecide(address: string, allow: boolean): void }) {
  const waiting = requests.filter(item => !item.denied).sort((a, b) => a.firstSeen - b.firstSeen);
  const current = suppressed ? undefined : waiting[0];
  const dialog = useRef<HTMLDialogElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const names = useDeviceNames(current ? [current.address] : []);
  useEffect(() => {
    if (!current) return;
    if (!dialog.current?.open) dialog.current?.showModal();
    deny.current?.focus();
    // Bring the main window forward: the user may be in the Tools or Breakpoints window, or in another app.
    void (window as unknown as { streamglass?: DeviceNames }).streamglass?.lanApprovalAttention?.().catch(() => {});
  }, [current?.address]);
  if (!current) return null;
  const name = names[current.address];
  return <dialog ref={dialog} className="approval-dialog lan-prompt" aria-label="Device approval" onCancel={event => { event.preventDefault(); if (!busy) onDecide(current.address, false); }}>
    <div className="approval-head"><Smartphone aria-hidden="true"/><div><span className="approval-kind">New device</span><h2>A device wants to use this proxy</h2></div></div>
    <div className="approval-body">
      <div className="lan-prompt-device"><strong className="mono">{current.address}</strong>{name && name !== current.address && <span>{name}</span>}<small className="muted">{refusals(current.attempts)}</small></div>
      <p className="approval-warn"><ShieldAlert size={12} aria-hidden="true"/>Allow only your own test device. It will be able to send traffic through this Mac.</p>
      <p>Denied devices stay refused until you allow them in Settings → Proxy.{expiry?.enabled ? ' An approval lasts 7 days.' : ''}</p>
      {waiting.length > 1 && <p className="muted">+{waiting.length - 1} waiting</p>}
    </div>
    <div className="approval-foot"><span className="muted">Refused until you decide</span><button ref={deny} disabled={busy} onClick={() => onDecide(current.address, false)}>Deny</button><button className="primary" disabled={busy} onClick={() => onDecide(current.address, true)}>Allow device</button></div>
  </dialog>;
}

/** Approved, waiting and refused LAN devices with their actions. Shared by Settings and Connect a device. */
/** "expires in 6 days" from an approval time; empty when expiry is off or the time is unknown. */
export function expiryLabel(approvedAt: number | undefined, ttlSeconds: number | undefined, now = Date.now() / 1000) {
  if (!approvedAt || !ttlSeconds) return '';
  const left = approvedAt + ttlSeconds - now;
  if (left <= 0) return 'expiring';
  if (left < 3600) return 'expires in under an hour';
  if (left < 86400) { const hours = Math.round(left / 3600); return `expires in ${hours} hour${hours === 1 ? '' : 's'}`; }
  const days = Math.round(left / 86400);
  return `expires in ${days} day${days === 1 ? '' : 's'}`;
}
export type LanExpiry = { enabled: boolean; ttlSeconds?: number; approvals?: Record<string, number> };

export function LanDeviceList({ devices, requests, busy, expiry, onRemoveDevice, onDecide }: {
  devices: string[]; requests: LanRequest[]; busy: boolean; expiry?: LanExpiry; onRemoveDevice(address: string): void; onDecide(address: string, allow: boolean): void;
}) {
  const waiting = requests.filter(item => !item.denied), refused = requests.filter(item => item.denied);
  const names = useDeviceNames([...devices, ...requests.map(item => item.address)]);
  const label = (address: string) => <span className="lan-device"><span className="mono">{address}</span>{names[address] && names[address] !== address && <small className="muted">{names[address]}</small>}</span>;
  return <div className="lan-devices">
    {!!waiting.length && <><p className="lan-list-title waiting">Waiting for approval</p><ul className="lan-list waiting" aria-label="Devices waiting for approval">{waiting.map(item => <li key={item.address}>{label(item.address)}<span className="lan-actions"><button disabled={busy} onClick={() => onDecide(item.address, false)}>Deny</button><button className="primary" disabled={busy} aria-label={`Allow device ${item.address}`} onClick={() => onDecide(item.address, true)}>Allow device</button></span></li>)}</ul></>}
    {devices.length ? <ul className="lan-list" aria-label="Approved devices">{devices.map(address => <li key={address}>{label(address)}{expiry?.enabled && <small className="muted lan-expiry">{expiryLabel(expiry.approvals?.[address], expiry.ttlSeconds)}</small>}<button className="icon-button" aria-label={`Remove device ${address}`} title="Remove device" disabled={busy} onClick={() => onRemoveDevice(address)}><X size={13}/></button></li>)}</ul> : <p className="muted">No approved devices yet.</p>}
    {!!refused.length && <><p className="lan-list-title">Refused</p><ul className="lan-list" aria-label="Refused devices">{refused.map(item => <li key={item.address}>{label(item.address)}<button disabled={busy} aria-label={`Allow device ${item.address}`} onClick={() => onDecide(item.address, true)}>Allow</button></li>)}</ul></>}
  </div>;
}

/** Proxy settings for LAN access: approved devices and private destinations LAN devices may reach. */
export function LanAccessSettings({ devices, requests, destinations, busy, expiry, onExpiry, onDestinations, onRemoveDevice, onDecide }: {
  devices: string[]; requests: LanRequest[]; destinations: string; busy: boolean; expiry: LanExpiry; onExpiry(enabled: boolean): void;
  onDestinations(value: string): void; onRemoveDevice(address: string): void; onDecide(address: string, allow: boolean): void;
}) {
  return <div className="lan-access">
    <div className="setting-summary"><ShieldAlert/><div><strong>Approved devices</strong><p>Only these devices can use the proxy over the network. A new one is refused until you allow it.</p></div></div>
    <LanDeviceList devices={devices} requests={requests} busy={busy} expiry={expiry} onRemoveDevice={onRemoveDevice} onDecide={onDecide}/>
    <label className="check lan-expiry-toggle"><input type="checkbox" checked={expiry.enabled} disabled={busy} onChange={event => onExpiry(event.target.checked)}/>Forget approved devices after 7 days</label>
    <small className="muted">Office and shared Wi-Fi reassign addresses, so an old approval could pass to another device. Applies immediately; allowing a device again renews its 7 days.</small>
    <label>LAN destinations<textarea className="mono" rows={3} value={destinations} placeholder={'staging.example.internal\n10.20.0.0/16'} onChange={event => onDestinations(event.target.value)}/>
      <small>Private hosts, IPs or CIDR ranges that approved devices may reach, one per line. Blocked by default: this Mac, private and VPN ranges. Simulators and adb reverse are not restricted.</small></label>
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
      <small>About {large} large (5 MB) responses. Lowering the limit drops the oldest captures on save; other traffic has its own 256 MiB budget.</small></label>
  </div>;
}
