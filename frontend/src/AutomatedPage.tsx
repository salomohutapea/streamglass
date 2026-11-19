import type { ReactNode } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import type { AndroidDevice, DeviceInventory, IosSimulator } from './device-setup-types';

type Device = AndroidDevice | IosSimulator;
/** Emulator (Android) or Simulator (iOS) page: Connect all plus one card per running device. */
export default function AutomatedPage({ os, inventory, devices, busy, working, metro, canConnect, onConnectAll, renderCard, metroCallout }: {
  os: 'ios' | 'android'; inventory: DeviceInventory | null; devices: Device[]; busy: boolean; working: boolean; metro: boolean; canConnect: boolean; onConnectAll(): void; renderCard(device: Device): ReactNode; metroCallout?: ReactNode;
}) {
  const ios = os === 'ios';
  const ready = (d: Device) => 'serial' in d ? d.state === 'device' : d.state === 'Booted';
  const pending = devices.some(d => !d.connection && ready(d));
  const proxyPort = inventory?.lan.proxyPort;
  const watching = !inventory ? 'Device discovery unavailable' : ios ? 'Watching booted simulators' : `Watching adb · proxy :${proxyPort}`;
  return <>
    <p className="ds-lede">{ios ? 'Simulators share this Mac’s network. Connect installs the certificate and turns on this Mac’s proxy.' : 'Emulators connect through adb. No Wi-Fi or local network access needed.'}</p>
    {metroCallout}
    {devices.length ? <>
      <div className="ds-toolbar"><button type="button" className="primary" disabled={busy || !canConnect || !pending} onClick={onConnectAll}>{working ? 'Connecting…' : 'Connect all'}</button><span className="ds-spacer"/>
        <span className="ds-watch"><span className="ds-pulse" aria-hidden="true"/>{watching}{metro ? ' · Metro :8081' : ''}</span></div>
      {devices.map(renderCard)}
    </> : <div className="ds-empty">{ios ? <Smartphone size={20}/> : <Monitor size={20}/>}<h3>{ios ? 'No simulator booted' : 'No emulator running'}</h3>
      {ios ? (inventory?.simctlAvailable === false ? 'Install Xcode and its command-line tools, then boot a simulator.' : 'Boot one in Xcode and it appears here automatically.')
        : (inventory?.adbAvailable === false ? 'Install Android SDK platform-tools, then start an emulator in Android Studio.' : 'Start one in Android Studio and it appears here automatically.')}
    </div>}
  </>;
}
