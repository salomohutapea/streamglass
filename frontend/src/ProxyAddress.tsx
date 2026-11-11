import { useEffect, useRef, useState } from 'react';
import './proxy-address.css';

export default function ProxyAddress({ addresses, port, local = false, step }: { addresses: string[]; port: number; local?: boolean; step?: number }) {
  const [selected, setSelected] = useState('');
  const [feedback, setFeedback] = useState('');
  const [manualCopy, setManualCopy] = useState('');
  const manualInput = useRef<HTMLInputElement>(null);
  const address = addresses.includes(selected) ? selected : addresses[0] ?? '';
  const endpoint = `${address.includes(':') ? `[${address}]` : address}:${port}`;
  useEffect(() => { if (manualCopy) { manualInput.current?.focus(); manualInput.current?.select(); } }, [manualCopy]);
  async function copy(value: string, label: string) {
    setManualCopy('');
    try {
      if (window.streamglass?.copyText) await window.streamglass.copyText(value);
      else await navigator.clipboard.writeText(value);
      setFeedback(`${label} copied`);
    } catch {
      setManualCopy(value);
      setFeedback('Copy the selected value');
    }
  }
  return <section className="proxy-address" aria-label="HTTP proxy address">
    <div className="proxy-address-heading">{step ? <span className="connect-step-label"><i>{step}</i>Set the proxy on the device</span> : <strong>HTTP proxy</strong>}<span>{local ? 'This Mac' : 'Wi-Fi'}</span></div>
    {step && <p className="proxy-address-help">Enter this in the device's Wi-Fi settings under HTTP proxy → Manual. This is the address traffic goes through.</p>}
    <div className="proxy-address-values">
      <label>IP address{addresses.length > 1 ? <select aria-label="Proxy IP address" value={address} onChange={event => { setSelected(event.target.value); setFeedback(''); setManualCopy(''); }}>{addresses.map(ip => <option value={ip} key={ip}>{ip}</option>)}</select> : <input aria-label="Proxy IP address" readOnly value={address || 'No LAN address'} onFocus={event => event.target.select()}/>}</label>
      <label>Port<input aria-label="Proxy port" readOnly value={port} onFocus={event => event.target.select()}/></label>
    </div>
    <div className="proxy-address-actions"><button disabled={!address} onClick={() => void copy(address, 'IP address')}>Copy IP</button><button disabled={!address} onClick={() => void copy(String(port), 'Port')}>Copy port</button><button disabled={!address} onClick={() => void copy(endpoint, 'IP:port')}>Copy IP:port</button></div>
    {!address && <p className="muted">No LAN address. Join a network.</p>}
    <p className="proxy-copy-status" role="status" aria-live="polite">{feedback}</p>
    {manualCopy && <input ref={manualInput} aria-label="Copy proxy value manually" readOnly value={manualCopy} onFocus={event => event.target.select()}/>}
  </section>;
}
