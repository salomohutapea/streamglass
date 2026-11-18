import type { DeviceInventory } from './device-setup-types';
import { Section, Segmented } from './device-setup-ui';

type Patch = Partial<DeviceInventory['options']> & { metroMode?: DeviceInventory['metro']['mode'] };
/** Options and Troubleshooting sections shown at the bottom of every mobile page. */
export default function DeviceOptions({ inventory, metro, disabled, onChange, onTlsSettings }: { inventory: DeviceInventory | null; metro: boolean; disabled: boolean; onChange(patch: Patch): void; onTlsSettings?(): void }) {
  const off = disabled || !inventory;
  const checks = [['reapply', 'Re-apply when an emulator restarts or adb reconnects'], ['revertOnQuit', 'Revert proxies set by Streamglass when it quits'], ['autoConnect', 'Connect new emulators and simulators automatically']] as const;
  return <>
    <Section title="Options"><div className="ds-opts">
      <div className="ds-opt-row"><span>React Native / Metro</span>
        <Segmented label="Metro mode" value={inventory?.metro.mode ?? 'auto'} disabled={off} items={[{ id: 'auto', label: 'Auto' }, { id: 'always', label: 'Always' }, { id: 'off', label: 'Off' }]} onChange={metroMode => onChange({ metroMode })}/>
        <span className="ds-hint-text">Wi-Fi guidance appears only while Metro runs on <code>:8081</code>. Always also shows Metro on automated setup cards.</span></div>
      {checks.map(([key, text]) => <label className="ds-check" key={key}><input type="checkbox" checked={inventory?.options[key] ?? key !== 'autoConnect'} disabled={off} onChange={event => onChange({ [key]: event.target.checked })}/>{text}</label>)}
    </div></Section>
    <Section title="Troubleshooting"><ul className="ds-trouble">
      {metro ? <li>React Native app shows a white screen: check the Metro row for the bundle request, then the app’s JS errors. A Metro status check alone isn’t enough.</li> : <li>Building a React Native app? Start Metro; its row appears automatically.</li>}
      <li>HTTPS rows without bodies: the certificate isn’t trusted by the app, or the app pins certificates. Add the domain to the TLS allowlist and reconnect.</li>
      <li>Device lost internet: press <b>Revert</b>. For a manual Wi-Fi proxy, set Proxy back to Off on the device.</li>
      <li>Traffic checks need capture to be running; paused capture can hide them.</li>
    </ul>{onTlsSettings && <button type="button" className="ds-sm" onClick={onTlsSettings}>TLS allowlist</button>}</Section>
  </>;
}
