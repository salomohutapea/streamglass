import './tls-failure.css';
import { AlertTriangle } from 'lucide-react';

export type TlsFailure = {side: 'client' | 'server'; reason: string; at: number; likelyCause: 'untrusted-ca' | 'pinning' | 'protocol' | 'unknown' | 'closed-after-handshake'};

const CAUSES: Record<TlsFailure['likelyCause'], string> = {
  'untrusted-ca': 'The device does not trust the Streamglass certificate authority.',
  pinning: 'The app most likely pins the server certificate and rejects the Streamglass certificate.',
  'closed-after-handshake': 'The client accepted the Streamglass certificate during the handshake, then closed the connection without sending a request. This usually means certificate pinning checked after the handshake (for example OkHttp CertificatePinner), or occasionally an unused pre-connection.',
  protocol: 'The two sides could not agree on a TLS protocol version or cipher.',
  unknown: 'The cause could not be determined from the handshake error.',
};

/** Explains a failed TLS handshake and offers to stop inspecting the host. Read-only apart from the allowlist action. */
export function TlsFailureCallout({failure, host, busy, onRemove}: {failure: TlsFailure; host: string; busy?: boolean; onRemove: (host: string) => void}) {
  const server = failure.side === 'server';
  return <div className="tls-failure-callout" role="alert">
    <h3><AlertTriangle size={16} /> TLS handshake failed ({server ? 'upstream server' : 'client'})</h3>
    <p>{server ? 'Streamglass could not complete TLS with the origin server.' : CAUSES[failure.likelyCause]} <code>{failure.reason}</code></p>
    {!server && <ul>
      {(failure.likelyCause === 'untrusted-ca' || failure.likelyCause === 'unknown') && <>
        <li><strong>iOS:</strong> install the Streamglass profile, then enable full trust in Settings, General, About, Certificate Trust Settings.</li>
        <li><strong>Android 7+:</strong> user CAs are ignored by apps unless debug builds add a network_security_config with <code>{'<certificates src="user"/>'}</code>.</li>
        <li><strong>React Native:</strong> same as native. Disable OkHttp CertificatePinner, TrustKit or react-native-ssl-pinning in debug builds.</li>
      </>}
      {(failure.likelyCause === 'pinning' || failure.likelyCause === 'closed-after-handshake') && <>
        <li>Disable certificate pinning in debug builds (OkHttp CertificatePinner, TrustKit, react-native-ssl-pinning, NSPinnedDomains).</li>
        <li>Or remove this host from the TLS allowlist so its traffic passes through uncaptured.</li>
      </>}
      {failure.likelyCause === 'protocol' && <li>Check that the client supports TLS 1.2 or newer and that the host really speaks TLS on this port.</li>}
    </ul>}
    {host && <button disabled={busy} onClick={() => onRemove(host)}>Remove {host} from TLS allowlist</button>}
  </div>;
}
