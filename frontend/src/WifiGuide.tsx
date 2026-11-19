import { useState, type ReactNode } from 'react';
import { deviceEvidence, formatBytes, type SetupRecord } from './device-setup-evidence.mjs';
import { useDeviceNames, type LanExpiry, type LanRequest } from './SecurityPrompts';
import { CopyButton, QrCode, Spinner, Step, TrustHelp, networkConfig, type StepMark } from './device-setup-ui';

export type LanApproval = { devices: string[]; requests: LanRequest[]; busy: boolean; expiry?: LanExpiry; onDecide(address: string, allow: boolean): void; onRemoveDevice(address: string): void };
type Props = {
  os: 'ios' | 'android'; ip: string; proxyPort: number; lanOn: boolean; setupUrl: string; fingerprint?: string | null; siteError?: string;
  records: SetupRecord[]; baseline: number; androidAddresses: string[]; metro: boolean; lan?: LanApproval; onFilterDevice?(id: string): void;
};

/** The manual Wi-Fi guide for physical phones (QA-friendly): proxy, certificate, approval and live checks. */
export default function WifiGuide({ os, ip, proxyPort, lanOn, setupUrl, fingerprint, siteError, records, baseline, androidAddresses, metro, lan, onFilterDevice }: Props) {
  const ios = os === 'ios';
  const host = ip.includes(':') ? `[${ip}]` : ip;
  const phoneRecords = lanOn ? records.filter(r => r.clientIsLocal === false && !!r.device
    && (!lan || lan.devices.includes(r.device))
    && (androidAddresses.includes(r.device) ? os === 'android' : r.devicePlatform === os)) : [];
  const addresses = [...new Set(phoneRecords.map(r => r.device).filter((id): id is string => !!id))];
  const [selected, setSelected] = useState('');
  const phone = addresses.includes(selected) ? selected : addresses[0];
  const waiting = (lan?.requests ?? []).filter(item => !item.denied), refused = (lan?.requests ?? []).filter(item => item.denied);
  const names = useDeviceNames([...(phone ? [phone] : []), ...(lan?.requests.map(item => item.address) ?? [])]);
  const label = (address: string) => names[address] && names[address] !== address ? <><b>{names[address]}</b> (<code>{address}</code>)</> : <b>{address}</b>;
  const evidence = deviceEvidence(phone ? phoneRecords : [], { addresses: phone ? [phone] : [], since: baseline });
  const proxyShown = ip || 'this Mac’s LAN address';
  const https = evidence.https;
  const approved = !!phone;

  const approval: ReactNode = <>
    {waiting.map(item => <div className="ds-ask" key={item.address}><span>{label(item.address)} wants to use the proxy.</span><span className="ds-spacer"/><button type="button" className="ds-sm" disabled={lan?.busy} onClick={() => lan?.onDecide(item.address, false)}>Deny</button><button type="button" className="ds-sm primary" disabled={lan?.busy} aria-label={`Allow device ${item.address}`} onClick={() => lan?.onDecide(item.address, true)}>Allow device</button></div>)}
    {lanOn && !waiting.length && !approved && <div className="ds-d"><Spinner/> Waiting for new traffic. Open an app on the phone to verify the proxy.</div>}
    {refused.map(item => <div className="ds-ask muted" key={item.address}><span>{label(item.address)} was refused.</span><span className="ds-spacer"/><button type="button" className="ds-sm" disabled={lan?.busy} aria-label={`Allow device ${item.address}`} onClick={() => lan?.onDecide(item.address, true)}>Allow</button></div>)}
  </>;

  const steps: { mark: StepMark; title: ReactNode; body: ReactNode; actions?: ReactNode; extra?: ReactNode }[] = [];
  steps.push({
    mark: evidence.traffic ? 'ok' : 'num', title: 'Set the Wi-Fi proxy',
    body: <>{ios ? 'Settings → Wi-Fi → (i) next to your network → Configure Proxy → ' : 'Settings → Wi-Fi → your network → Edit → Advanced → Proxy '}<b>Manual</b>: {ios ? 'server' : 'host'} <code className="ds-proxy-value">{proxyShown}</code>, port <code className="ds-proxy-value">{proxyPort}</code>.</>,
    actions: ip ? <CopyButton value={ip}>Copy address</CopyButton> : undefined, extra: approval,
  });
  steps.push({
    mark: evidence.tlsVerified ? 'ok' : 'num', title: 'Install the certificate',
    body: evidence.tlsVerified ? 'HTTPS decryption verified for this device.'
      : ios ? <>Scan the QR code to download the profile. Install it in Settings → General → VPN &amp; Device Management, then enable full trust in General → About → Certificate Trust Settings.</>
      : <>Scan the QR code to download the CA. Install it in Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate.</>,
  });
  if (!evidence.tlsVerified || https === 'error') steps.push({
    mark: https === 'error' ? 'warn' : 'num', title: https === 'error' ? 'TLS handshake failed' : 'Verify HTTPS',
    body: https === 'error' ? (ios ? <>Requests{evidence.failure?.host ? <> to <code>{evidence.failure.host}</code></> : ''} fail the TLS handshake. Full trust (previous step) is most likely still off. The app may also pin certificates.</> : <>{evidence.failure?.app ? <code>{evidence.failure.app}</code> : 'The app'} rejects the certificate. Its debug build must trust user CAs, or it pins certificates.</>)
      : 'Add the domain to the TLS allowlist, then open it on the device.',
    actions: https === 'error' && !ios ? <CopyButton value={networkConfig}>Copy config</CopyButton> : undefined,
    extra: https === 'error' && !ios ? <TrustHelp/> : undefined,
  });
  if (metro) steps.push({
    mark: evidence.metro ? 'ok' : 'num', title: 'Metro over Wi-Fi', actions: ip ? <CopyButton value={`${host}:8081`}>Copy {host}:8081</CopyButton> : undefined,
    body: <>{ios ? <>Your dev build loads the bundle from this Mac’s address (<code>{ip ? `${host}:8081` : 'Mac address:8081'}</code>), set at build time. It goes through the proxy, so Streamglass sees it.</>
      : <><code>localhost:8081</code> through the proxy reaches Metro on this Mac. If your app skips the proxy for localhost, open the RN Dev Menu → <b>Change bundle location</b> → <code>{ip ? `${host}:8081` : 'Mac address:8081'}</code>.</>}
      {evidence.bundle ? <> Last bundle {evidence.bundle.status}{evidence.bundle.size != null ? ` · ${formatBytes(evidence.bundle.size)}` : ''}{evidence.bundle.durationMs != null ? ` · ${(evidence.bundle.durationMs / 1000).toFixed(1)} s` : ''}.</> : ' Waiting for a successful bundle request.'}</>,
  });
  steps.push({
    mark: evidence.traffic ? 'ok' : 'num', title: 'Traffic',
    body: evidence.traffic ? <>Captured from <code>{phone}</code>.</> : 'Open an app on the phone.',
    actions: evidence.traffic && phone && onFilterDevice ? <button type="button" className="ds-sm ghost" onClick={() => onFilterDevice(phone)}>Filter captures</button> : undefined,
  });

  return <div className="ds-split">
    <div className="ds-qrcol">
      {lanOn && setupUrl ? <><QrCode text={setupUrl} label="QR code for the certificate page"/><div className="ds-qrcap">Certificate page<br/><code>{setupUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}</code></div>
        <CopyButton ghost value={setupUrl}>Copy URL</CopyButton>
        <details className="ds-cert-details"><summary>Setup details</summary>
          <CopyButton ghost value={`${setupUrl.replace(/\/$/, '')}/proxy.pac`}>Copy PAC URL</CopyButton>
          {fingerprint && <div className="ds-qrcap ds-fp">SHA-256<br/><code>{fingerprint}</code></div>}
        </details></>
        : <div className="ds-qr-off">{!lanOn ? 'Turn on local network access for the certificate QR code.' : siteError || 'Certificate page is not available yet.'}</div>}
    </div>
    <div className="ds-guide">
      {addresses.length > 1 && <label className="ds-phone-pick">Live checks for <select value={phone ?? ''} onChange={event => setSelected(event.target.value)}>{addresses.map(address => <option key={address} value={address}>{names[address] && names[address] !== address ? `${names[address]} (${address})` : address}</option>)}</select></label>}
      {steps.map((step, index) => <Step key={index} number={index + 1} mark={step.mark} title={step.title} actions={step.actions} extra={step.extra}>{step.body}</Step>)}
    </div>
  </div>;
}
