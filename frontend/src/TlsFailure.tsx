import './tls-failure.css';
import { AlertTriangle } from 'lucide-react';

export type TlsFailure = {side: 'client' | 'server'; reason: string; at: number; likelyCause: 'untrusted-ca' | 'pinning' | 'protocol' | 'unknown' | 'closed-after-handshake'};

const CAUSES: Record<TlsFailure['likelyCause'], string> = {
  'untrusted-ca': 'Certificate not trusted yet.',
  pinning: 'Likely certificate pinning.',
  'closed-after-handshake': 'Closed after handshake. Likely pinning.',
  protocol: 'No shared TLS version or cipher.',
  unknown: 'Cause unknown.',
};

/** Explains a failed TLS handshake and offers to stop inspecting the host. Read-only apart from the allowlist action. */
export function TlsFailureCallout({failure, host, busy, onRemove}: {failure: TlsFailure; host: string; busy?: boolean; onRemove: (host: string) => void}) {
  const server = failure.side === 'server';
  return <div className="tls-failure-callout" role="alert">
    <h3><AlertTriangle size={16} /> TLS failed ({server ? 'server' : 'client'})</h3>
    <p>{server ? 'Origin TLS failed.' : CAUSES[failure.likelyCause]} <code>{failure.reason}</code></p>
    {!server && <ul>
      {(failure.likelyCause === 'untrusted-ca' || failure.likelyCause === 'unknown') && <>
        <li><strong>iOS:</strong> enable full trust in Settings → General → About → Certificate Trust Settings.</li>
        <li><strong>Android 7+:</strong> apps need <code>{'<certificates src="user"/>'}</code> in debug builds.</li>
      </>}
      {(failure.likelyCause === 'pinning' || failure.likelyCause === 'closed-after-handshake') && <>
        <li>Disable pinning in debug builds.</li>
        <li>Or remove the host from the TLS allowlist.</li>
      </>}
      {failure.likelyCause === 'protocol' && <li>Client needs TLS 1.2+.</li>}
    </ul>}
    {host && <button disabled={busy} onClick={() => onRemove(host)}>Stop inspecting {host}</button>}
  </div>;
}
