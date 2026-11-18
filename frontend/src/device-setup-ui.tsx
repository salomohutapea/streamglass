import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, Loader2, Monitor, Smartphone, Wifi } from 'lucide-react';
import { encodeQr } from './qr-code.mjs';
import type { Tone } from './device-setup-view.mjs';
import './connect-device.css';

/** Small presentational pieces shared by the Connect a device pages. No device logic lives here. */
export type StepMark = 'ok' | 'warn' | 'idle' | 'num' | 'run';

export function QrCode({ text, label }: { text: string; label: string }) {
  const qr = useMemo(() => { try { return encodeQr(text); } catch { return null; } }, [text]);
  if (!qr) return null;
  const quiet = 3, side = qr.size + quiet * 2;
  let path = '';
  qr.modules.forEach((row, r) => { let c = 0; while (c < qr.size) { if (!row[c]) { c++; continue; } const start = c; while (c < qr.size && row[c]) c++; path += `M${start + quiet} ${r + quiet}h${c - start}v1h${start - c}z`; } });
  return <svg className="qr-code" role="img" aria-label={label} viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges"><rect width={side} height={side} fill="#fff"/><path d={path} fill="#000"/></svg>;
}

/** Re-renders every `interval` ms so relative times ("3 s ago") stay current. */
export function useNow(interval = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(timer); }, [interval]);
  return now;
}

export function CopyButton({ value, children = 'Copy', ghost = false }: { value: string; children?: ReactNode; ghost?: boolean }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className={`ds-sm${ghost ? ' ghost' : ''}`} onClick={async () => { try { if (window.streamglass?.copyText) await window.streamglass.copyText(value); else await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); } }}><Copy size={12}/>{copied ? 'Copied' : children}</button>;
}

const markNames: Record<StepMark, string> = { ok: 'done', warn: 'needs attention', idle: 'waiting', num: 'to do', run: 'in progress' };
export function Step({ mark, number, title, children, actions, extra }: { mark: StepMark; number?: number; title: ReactNode; children?: ReactNode; actions?: ReactNode; extra?: ReactNode }) {
  return <div className="ds-step">
    <span className={`ds-mark ${mark}`} role="img" aria-label={markNames[mark]}>{mark === 'ok' ? <Check size={11} strokeWidth={3}/> : mark === 'warn' ? '!' : mark === 'run' ? '' : mark === 'idle' ? '' : number}</span>
    <div><b>{title}</b>{children && <div className="ds-d">{children}</div>}{extra}</div>
    {actions && <div className="ds-acts">{actions}</div>}
  </div>;
}

export function Pills({ items }: { items: [string, Tone][] }) {
  return <div className="ds-pills">{items.map(([label, tone]) => <span className="ds-pill" key={label}><span className={`ds-dot ${tone}`} aria-hidden="true"/>{label}<span className="ds-sr-only">: {{ ok: 'ok', warn: 'needs attention', err: 'failed', spin: 'in progress', idle: 'pending' }[tone]}</span></span>)}</div>;
}

export function Chips({ items }: { items: { label: string; tone?: 'ok' | 'acc' }[] }) {
  return <>{items.map(chip => <span key={chip.label} className={`ds-chip ${chip.tone ?? ''}`}>{chip.label}</span>)}</>;
}

export function Segmented<T extends string>({ label, value, items, onChange, disabled }: { label: string; value: T; items: { id: T; label: string }[]; onChange(id: T): void; disabled?: boolean }) {
  return <div className="ds-seg" role="group" aria-label={label}>{items.map(item => <button type="button" key={item.id} aria-pressed={value === item.id} disabled={disabled} onClick={() => onChange(item.id)}>{item.label}</button>)}</div>;
}

export function Section({ title, hint, children, onToggle }: { title: string; hint?: ReactNode; children: ReactNode; onToggle?(open: boolean): void }) {
  return <details className="ds-sec" onToggle={event => onToggle?.(event.currentTarget.open)}><summary>{title}{hint && <span className="ds-hint">{hint}</span>}</summary><div className="ds-sec-body">{children}</div></details>;
}

export function Callout({ tone = 'warn', children }: { tone?: 'warn' | 'info'; children: ReactNode }) {
  return <div className={`ds-callout ${tone}`}>{children}</div>;
}

export function SubTabs({ label, value, items, onChange }: { label: string; value: string; items: { id: string; label: string }[]; onChange(id: string): void }) {
  return <div className="ds-subtabs" role="tablist" aria-label={label}>{items.map((item, index) => <button key={item.id} id={`ds-tab-${item.id}`} role="tab" type="button" aria-selected={value === item.id} aria-controls="ds-page" tabIndex={value === item.id ? 0 : -1} onClick={() => onChange(item.id)} onKeyDown={event => {
    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!offset && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + offset + items.length) % items.length];
    onChange(next.id); document.getElementById(`ds-tab-${next.id}`)?.focus();
  }}>{item.label}</button>)}</div>;
}

export const DeviceIcon = ({ kind }: { kind: 'emulator' | 'phone' }) => kind === 'emulator' ? <Monitor size={18}/> : <Smartphone size={18}/>;
export const WifiIcon = () => <Wifi size={18}/>;
export const Spinner = () => <Loader2 className="ds-spin" size={11} aria-hidden="true"/>;

export const networkConfig = `<!-- android/app/src/debug/res/xml/network_security_config.xml -->
<network-security-config>
  <debug-overrides>
    <trust-anchors><certificates src="user" /></trust-anchors>
  </debug-overrides>
</network-security-config>`;

/** Shown when an Android app refuses the handshake because it does not trust user CAs. */
export function TrustHelp({ emulator = false }: { emulator?: boolean }) {
  return <Callout>Add this to the app’s <b>debug</b> build, reference it from the manifest with <code>android:networkSecurityConfig</code>, and rebuild{emulator ? ', or use a Google APIs emulator, where Streamglass installs a system CA' : ''}. <code>debug-overrides</code> applies only to debuggable builds; other variants need the user trust anchor in their own configuration.<pre className="ds-snippet">{networkConfig}</pre></Callout>;
}
