import type { ReactNode } from 'react';
import type { AndroidDevice, DeviceInventory } from './device-setup-types';
import type { SetupRecord } from './device-setup-evidence.mjs';
import { QrCode, Section } from './device-setup-ui';
import WifiGuide, { type LanApproval } from './WifiGuide';

type Props = {
  os: 'ios' | 'android'; inventory: DeviceInventory | null; ip: string; proxyPort: number; lanOn: boolean; setupUrl: string; fingerprint?: string | null; siteError?: string;
  records: SetupRecord[]; baseline: number; metro: boolean; lan?: LanApproval; onFilterDevice?(id: string): void;
  renderCard(device: AndroidDevice): ReactNode; pairingQr: string; canPair: boolean; busy: boolean; onPair(): void; onCancelPair(): void; onShortcutsToggle(open: boolean): void;
};

/** Real-device page: the Wi-Fi guide first, and (Android only) collapsed developer shortcuts that automate it over adb. */
export default function RealDevicePage(props: Props) {
  const { os, inventory, renderCard, pairingQr, canPair, busy, onPair, onCancelPair, onShortcutsToggle } = props;
  const wifi = inventory?.android.filter(d => d.kind === 'physical' && d.transport === 'wifi') ?? [];
  const usb = inventory?.android.filter(d => d.kind === 'physical' && d.transport === 'usb') ?? [];
  const pairing = pairingQr && <div className="ds-pairing"><QrCode text={pairingQr} label="Wireless debugging pairing QR code"/><p>On the phone: Developer options → Wireless debugging → Pair device with QR code. Once paired, the phone appears here.</p><button type="button" className="ds-sm" onClick={onCancelPair}>Cancel pairing</button></div>;
  return <>
    <WifiGuide {...props} androidAddresses={wifi.flatMap(device => device.address ? [device.address] : [])}/>
    <p className="ds-note ds-wifi-reset">When finished, turn off any manual Wi-Fi proxy on the phone.</p>
    {os === 'android' && <Section title="Developer shortcuts" hint="Wireless debugging or USB" onToggle={onShortcutsToggle}>
      <div className="ds-h4 first">Wireless debugging</div>
      {wifi.length ? <>{wifi.map(renderCard)}<button type="button" className="ds-sm ghost" disabled={busy || !canPair || !!pairingQr} onClick={onPair}>+ Pair another phone</button></>
        : !pairingQr && <button type="button" disabled={busy || !canPair} onClick={onPair}>Pair with QR code</button>}
      {pairing}
      <div className="ds-h4">USB</div>
      {usb.length ? usb.map(renderCard) : <span className="ds-hint-text">Plug in the phone and allow USB debugging.</span>}
    </Section>}
  </>;
}
