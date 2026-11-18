import { Info } from 'lucide-react';
import type { SetupRecord } from './device-setup-evidence.mjs';
import ProxyAddress from './ProxyAddress';

export type MacAction = 'mac-enable-proxy' | 'mac-restore-proxy' | 'mac-trust-ca';
export type MacInventory = {
  networkServices?: { id: string; name: string; interface: string | null; proxyEnabled?: boolean; canRestore?: boolean }[];
  activeNetworkId?: string | null;
  networkNotice?: string;
  monitorEnabled?: boolean;
  monitorOverride?: string | null;
  monitorError?: string;
  monitorRestoreError?: string;
  savedProxyTargets?: string[];
  proxyPort?: number;
  macCertificate?: { installed: boolean; trusted: boolean | null } | null;
};

export type ThisMacSetup = {
  inventory: MacInventory | null;
  networkOverride: string | null;
  busy: boolean;
  available: boolean;
  proxyRunning?: boolean;
  capturePaused?: boolean;
  feedback?: { text: string; error?: boolean };
  onNetworkChange(value: string): void;
  onRefresh(): void;
  onAction(action: MacAction): void;
};

type Props = ThisMacSetup & {
  port: number;
  records: SetupRecord[];
  baseline: number;
  onTlsSettings?(): void;
};

export default function ThisMacPage({ inventory, networkOverride, busy, available, proxyRunning, capturePaused, feedback,
  onNetworkChange, onRefresh, onAction, onTlsSettings, port, records, baseline }: Props) {
  const services = inventory?.networkServices ?? [];
  const appliedOverride = inventory?.monitorOverride ?? '';
  const selectedOverride = networkOverride ?? appliedOverride;
  const networkChanged = selectedOverride !== appliedOverride;
  const currentNetwork = services.find(service => service.id === (appliedOverride || inventory?.activeNetworkId));
  const selectedId = selectedOverride || inventory?.activeNetworkId;
  const selectedNetwork = services.find(service => service.id === selectedId);
  const networkName = selectedNetwork?.name ?? selectedId;
  const networkSummary = networkName && !selectedOverride ? `${networkName} · Automatic` : networkName || 'Automatic';
  const configured = currentNetwork?.proxyEnabled === true;
  const endpoint = `127.0.0.1:${inventory?.proxyPort ?? port}`;
  const monitorError = inventory?.monitorError || inventory?.monitorRestoreError;
  const monitorLabel = typeof inventory?.monitorEnabled === 'boolean' ? (inventory.monitorEnabled ? 'Monitor on' : 'Monitor off') : '';
  const canRestore = inventory?.savedProxyTargets?.some(target => target.startsWith('mac:')) === true;
  const needsEnable = !inventory?.monitorEnabled || !configured || proxyRunning === false || !!inventory?.monitorError;
  const certificate = inventory?.macCertificate;
  const certificateTrusted = certificate?.installed && certificate.trusted === true;
  let certificateStatus = typeof inventory?.proxyPort === 'number' ? 'Certificate status unavailable' : 'Checking certificate status';
  if (certificate) {
    if (!certificate.installed) certificateStatus = 'CA certificate missing';
    else if (certificateTrusted) certificateStatus = 'Installed and trusted';
    else if (certificate.trusted === false) certificateStatus = 'Installed · SSL trust check failed';
    else certificateStatus = 'Installed · Trust unavailable';
  }

  const localRecords = records.filter(record => {
    if (!record.clientIsLocal || record.deviceId || !record.application) return false;
    const { startedAt } = record;
    const time = typeof startedAt === 'number' ? (startedAt < 1e12 ? startedAt * 1000 : startedAt) : Date.parse(startedAt ?? '');
    return time >= baseline;
  });
  const requestCount = localRecords.filter(record => record.kind !== 'tunnel').length;
  const waiting = (configured || Boolean(inventory?.monitorEnabled)) && proxyRunning !== false;
  let trafficStatus = waiting ? 'Waiting for traffic' : 'None recorded';
  if (requestCount > 0) trafficStatus = `${requestCount} ${requestCount === 1 ? 'request' : 'requests'} recorded`;
  else if (localRecords.length === 1) trafficStatus = '1 connection recorded';
  else if (localRecords.length > 1) trafficStatus = `${localRecords.length} connections recorded`;
  const trafficHint = capturePaused === true ? 'Capture is paused.' : !localRecords.length && waiting ? 'Open an app or page on this Mac.' : '';

  return <>
    <div className="ds-mac-rows">
      <div className="ds-mac-row">
        <div>
          <span className="ds-mac-label">Mac capture</span>
          <span className="ds-mac-secondary" role="status">
            <span className={`ds-dot${configured && proxyRunning === true ? ' ok' : ''}`} aria-hidden="true"/>
            {configured ? <code>{endpoint}</code> : currentNetwork?.proxyEnabled === false ? 'Proxy off' : inventory?.proxyPort ? 'Proxy status unavailable' : 'Checking proxy settings'}
            {monitorLabel && <span> · {monitorLabel}</span>}
            {proxyRunning === false && <span> · Listener stopped</span>}
          </span>
        </div>
        <div className="ds-mac-actions">
          {needsEnable && <button type="button" className="primary" title="Save the current proxy settings and enable capture" disabled={!available || busy || !selectedNetwork} onClick={() => onAction('mac-enable-proxy')}>Enable capture</button>}
          {(canRestore || inventory?.monitorEnabled) && <button type="button" title="Turn off monitoring and restore saved Mac proxy settings" disabled={!available || busy} onClick={() => onAction('mac-restore-proxy')}>Disable capture</button>}
        </div>
      </div>
      <div className="ds-mac-info" role="note">
        <Info size={13} aria-hidden="true"/>
        <span>Mac capture may need administrator access. Ask Tech Support to enable it if you don’t have access.</span>
      </div>
      <div className="ds-mac-row">
        <div>
          <span className="ds-mac-label">Traffic</span>
          {trafficHint && <span className="ds-mac-secondary">{trafficHint}</span>}
        </div>
        <span className="ds-mac-secondary ds-mac-end" role="status">
          <span className={`ds-dot${localRecords.length ? ' ok' : ''}`} aria-hidden="true"/>{trafficStatus}{localRecords.length > 0 && ' since opening setup'}
        </span>
      </div>
      <div className="ds-mac-row ds-mac-https">
        <div>
          <span className="ds-mac-label">HTTPS inspection</span>
          <span className="ds-mac-secondary" role="status">
            {certificateTrusted && <span className="ds-dot ok" aria-hidden="true"/>}{certificateStatus}
          </span>
        </div>
        <div className="ds-mac-actions">
          <button type="button" disabled={!available || busy} onClick={() => onAction('mac-trust-ca')}>{certificate?.installed === false ? 'Install and trust' : 'Trust certificate'}</button>
          <button type="button" disabled={!onTlsSettings} onClick={onTlsSettings}>TLS allowlist</button>
        </div>
      </div>
      <details>
        <summary className="ds-mac-row">
          <span className="ds-mac-label">Network</span>
          <span className="ds-mac-secondary ds-mac-end">{networkSummary}{networkChanged && ' · Pending'}</span>
        </summary>
        <div className="ds-mac-details">
          <p>{inventory?.networkNotice ?? 'Detecting the active network…'}</p>
          <div className="ds-mac-network-controls">
            <label>Network service
              <select value={selectedOverride} disabled={busy || !available} onChange={event => onNetworkChange(event.target.value)}>
                <option value="">Automatic active network</option>
                {selectedOverride && !services.some(service => service.id === selectedOverride) && <option value={selectedOverride}>{selectedOverride} (unavailable)</option>}
                {services.map(service => <option key={service.id} value={service.id}>{service.name}{service.interface ? ` (${service.interface})` : ''}</option>)}
              </select>
            </label>
            {networkChanged && inventory?.monitorEnabled && <button type="button" disabled={!available || busy || !selectedNetwork} onClick={() => onAction('mac-enable-proxy')}>Apply network</button>}
            <button type="button" disabled={!available || busy} onClick={onRefresh}>Refresh networks</button>
          </div>
        </div>
      </details>
      <details>
        <summary className="ds-mac-row"><span className="ds-mac-label">Troubleshooting</span></summary>
        <div className="ds-mac-details">
          <ul>
            <li>Enable capture and open an app that uses the Mac system proxy.</li>
            <li>For HTTPS bodies, trust the certificate and add the domain to the TLS allowlist. Then reload.</li>
            <li>With a VPN, choose the active service in Network.</li>
            <li>Disable capture restores saved proxy settings. Use macOS System Settings to manage a proxy set elsewhere.</li>
          </ul>
          <ProxyAddress addresses={['127.0.0.1']} port={port} local/>
        </div>
      </details>
    </div>
    {configured && !currentNetwork?.canRestore && <p className="ds-mac-notice">Proxy set outside Streamglass. Manage it in macOS System Settings.</p>}
    {feedback && <p className={`ds-mac-notice${feedback.error ? ' error-text' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {monitorError && monitorError !== feedback?.text && <p className="ds-mac-notice error-text" role="alert">{monitorError}</p>}
  </>;
}
