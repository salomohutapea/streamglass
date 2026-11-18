import type { ReactNode } from 'react';
import type { AndroidDevice, IosSimulator, DeviceInventory } from './device-setup-types';
import { deviceEvidence, androidRecordIds, formatAgo, formatBytes, type SetupRecord } from './device-setup-evidence.mjs';
import { describeDevice, deviceHeading } from './device-setup-view.mjs';
import { Chips, CopyButton, DeviceIcon, Pills, Step, TrustHelp, networkConfig, useNow, type StepMark } from './device-setup-ui';

export type CardActions = { connect(): void; revert(): void; confirm(): void; reopen(): void; filter(id: string): void };
type Props = { soleProxiedEmulator?: boolean; device: AndroidDevice | IosSimulator; records: SetupRecord[]; baseline: number; metro: boolean; options?: DeviceInventory['options']; connecting: boolean; busy: boolean; canConnect: boolean; canRevert: boolean; canConfirm: boolean; canReopen: boolean; actions: CardActions };
const mark = (tone: string): StepMark => tone === 'ok' ? 'ok' : tone === 'spin' ? 'run' : tone === 'warn' || tone === 'err' ? 'warn' : 'idle';
const bundleText = (bundle: NonNullable<ReturnType<typeof deviceEvidence>['bundle']>) => [<code key="n">{bundle.name}</code>, ` ${bundle.status}`, bundle.size != null ? ` · ${formatBytes(bundle.size)}` : '', bundle.durationMs != null ? ` · ${(bundle.durationMs / 1000).toFixed(1)} s` : ''];

/** One automated device (emulator, simulator, wireless-debugging or USB phone): pills, Connect/Revert and per-layer steps. */
export default function DeviceCard({ soleProxiedEmulator = false, device, records, baseline, metro, options, connecting, busy, canConnect, canRevert, canConfirm, canReopen, actions }: Props) {
  const now = useNow();
  const android = 'serial' in device;
  const id = android ? device.serial : device.udid;
  const connection = device.connection;
  const heading = deviceHeading(device);
  const recordIds = android ? androidRecordIds(device, { soleProxiedEmulator: soleProxiedEmulator && !!connection }) : [`ios-simulator:${id}`];
  const wifiAddress = android && device.transport === 'wifi' ? device.address ?? null : null;
  const matched = records.filter(record => recordIds.includes(record.deviceId ?? '') || !!wifiAddress && record.device === wifiAddress);
  const filterId = matched[0]?.deviceId || matched[0]?.device || recordIds[0];
  const evidence = deviceEvidence(matched, { ids: recordIds, addresses: wifiAddress ? [wifiAddress] : [], since: Math.max(baseline, connection?.connectedAt ?? 0) });
  const view = describeDevice(device, { evidence, metro, connecting });
  const ready = android ? device.state === 'device' : device.state === 'Booted';
  const mode = connection?.cert.mode;
  const emulator = android && device.kind === 'emulator';
  const quitNote = options?.revertOnQuit === false ? 'Revert restores it.' : 'Reverted when Streamglass quits.';
  const value = connection?.proxy.value;
  const proxyText: ReactNode = !connection ? (android ? 'Setting the global proxy…' : 'Turning on this Mac’s proxy…')
    : !android ? <>Mac proxy{value && <> <code>{value}</code></>}. Restored on quit.</>
    : device.transport === 'usb' ? <>USB tunnel at <code>{value ?? '127.0.0.1'}</code>.</>
    : <>Global proxy <code>{value ?? 'set'}</code>. {quitNote}</>;
  const metroText: ReactNode = connection?.metro.detail && connection.metro.status !== 'ok' ? connection.metro.detail
    : !android ? <><code>localhost:8081</code> is this Mac; nothing to change.</>
    : device.transport === 'usb' ? <>USB tunnel for <code>:8081</code>.</>
    : device.transport === 'wifi' ? <><code>localhost:8081</code> through the proxy reaches Metro on this Mac.</>
    : <><code>10.0.2.2:8081</code> and <code>localhost:8081</code> both reach this Mac.</>;
  const failed = evidence.failure;
  let cert: ReactNode, certTitle = 'HTTPS certificate', certActions: ReactNode, certExtra: ReactNode;
  switch (view.cert) {
    case 'running': cert = mode === 'system' || android && emulator && device.rootable ? 'Restarting adb as root and installing the system CA…' : !android ? 'Adding the root certificate to the simulator keychain…' : 'Pushing the certificate and opening the installer…'; break;
    case 'auto': cert = 'Certificate installed. Waiting for an inspected HTTPS response.'; break;
    case 'tap': certTitle = 'Install the HTTPS certificate'; cert = <>On the device, open <b>Security → Encryption &amp; credentials → Install a certificate → CA certificate</b>. Choose <code>{connection?.cert.file ?? 'streamglass-ca.crt'}</code> from Downloads.</>;
      certActions = <><button type="button" className="ds-sm" disabled={busy || !canReopen} onClick={actions.reopen}>Open again</button><button type="button" className="ds-sm ghost" disabled={busy || !canConfirm} onClick={actions.confirm}>I installed it</button></>; break;
    case 'rejected': certTitle = 'HTTPS certificate · app rejects it';
      cert = <>{mode === 'user' ? 'The certificate is installed, but ' : ''}{failed?.app ? <code>{failed.app}</code> : 'The app'} refused the handshake{failed?.host ? <> for <code>{failed.host}</code></> : ''}. {mode === 'user' ? 'The app doesn’t trust user CAs, or it pins certificates.' : mode === 'system' ? 'The system CA is installed, so the app either has its own root store (as recent Chrome does) or pins certificates. Test with your own debug app.' : 'It most likely pins certificates.'}</>;
      if (mode === 'user') { certActions = <CopyButton value={networkConfig}>Copy config</CopyButton>; certExtra = <TrustHelp emulator={emulator && !device.rootable}/>; } break;
    case 'failed': certTitle = 'HTTPS certificate · setup failed'; cert = connection?.cert.detail || 'The certificate could not be installed. Use Retry setup.'; break;
    case 'trusted':
      cert = 'HTTPS decryption verified.';
      if (evidence.https === 'error') {
        certExtra = <div className="ds-d" role="status">A later TLS handshake failed{failed?.host && <> for <code>{failed.host}</code></>}.</div>;
      }
      break;
    case 'installed': cert = connection?.cert.detail || 'Certificate installed. Waiting for an inspected HTTPS request to verify app trust.'; break;
    default: cert = connection?.cert.detail || 'Waiting for the certificate to be installed.';
  }
  const metroStep = view.metro === 'hidden' ? null : <Step mark={mark(view.tones.metro)} title="Metro" actions={evidence.bundle && <button type="button" className="ds-sm ghost" onClick={() => actions.filter(filterId)}>Show</button>}>
    {connecting && !connection ? 'Waiting' : view.metro === 'bundle' && evidence.bundle ? <>Last bundle: {bundleText(evidence.bundle)}</> : <>{metroText} Waiting for a bundle request.</>}</Step>;
  const trafficText = evidence.traffic && evidence.first ? <>{evidence.count} captured · first seen {formatAgo(evidence.first.at, now)}</>
    : connecting && !connection ? 'Waiting' : 'Open your app to verify traffic.';
  const showSteps = connecting || !!connection;
  return <article className={`ds-dev ${view.state === 'connected' ? 'connected' : view.state === 'partial' ? 'partial' : ''}`} aria-label={heading.name}>
    <div className="ds-dev-row">
      <span className="ds-dev-ico"><DeviceIcon kind={heading.icon}/></span>
      <div className="ds-dev-main"><div className="ds-dev-name">{heading.name}<Chips items={heading.chips}/></div><div className="ds-dev-sub">{heading.sub}</div></div>
      <Pills items={view.pills as [string, never][]}/>
      <div>{connection && !connecting
        ? <button type="button" className="ghost" disabled={busy || !canRevert} onClick={actions.revert}>Revert</button>
        : <button type="button" className={connecting ? '' : 'primary'} disabled={busy || connecting || !ready || !canConnect} onClick={actions.connect}>{connecting ? 'Connecting…' : 'Connect'}</button>}</div>
    </div>
    {!ready && <p className="ds-note">{android && device.state === 'unauthorized' ? 'Unlock the phone and allow USB debugging, then reconnect.' : 'Start or reconnect the device to continue.'}</p>}
    {showSteps && <div className="ds-steps">
      <Step mark={mark(view.tones.proxy)} title="Proxy">{proxyText}</Step>
      <Step mark={mark(view.tones.cert)} title={certTitle} actions={certActions} extra={certExtra}>{cert}</Step>
      {metroStep}
      <Step mark={view.tones.traffic === 'ok' ? 'ok' : 'idle'} title="Traffic" actions={evidence.traffic && <button type="button" className="ds-sm ghost" onClick={() => actions.filter(filterId)}>Filter captures</button>}>{trafficText}</Step>
      {view.canRetry && !connecting && <button type="button" className="ds-sm" disabled={busy || !canConnect} onClick={actions.connect}>Retry setup</button>}
    </div>}
  </article>;
}
