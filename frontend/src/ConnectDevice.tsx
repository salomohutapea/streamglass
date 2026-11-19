import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AndroidDevice, DeviceInventory, DeviceRequest, IosSimulator, SetupSite } from './device-setup-types';
import { type SetupRecord } from './device-setup-evidence.mjs';
import { AnimatedHeight, Callout, Segmented, SubTabs, WifiIcon } from './device-setup-ui';
import DeviceCard from './DeviceCard';
import AutomatedPage from './AutomatedPage';
import RealDevicePage from './RealDevicePage';
import DeviceOptions from './DeviceOptions';
import ThisMacPage, { type ThisMacSetup } from './ThisMacPage';
import type { LanApproval } from './WifiGuide';
import './connect-device.css';

export type { LanApproval } from './WifiGuide';
export { QrCode } from './device-setup-ui';

const unavailable = 'Device automation is not available in this desktop version. You can still use the Wi-Fi guide.';
type Device = AndroidDevice | IosSimulator;
type Platform = 'mac' | 'ios' | 'android';
type Props = { initialStep?: number; onDone(): void; platform: string; onPlatform(key: string): void; lanAddresses: string[]; port: number; lanEnabled: boolean; records: SetupRecord[]; mac: ThisMacSetup; lan?: LanApproval; onMacProxiesReverted(): Promise<void>; onTlsSettings?(): void; onFilterDevice?(id: string): void };
const deviceId = (device: Device) => 'serial' in device ? device.serial : device.udid;
const requestFor = (device: Device): DeviceRequest => ({ platform: 'serial' in device ? 'android' : 'ios-simulator', id: deviceId(device) });
const online = (device: Device) => 'serial' in device ? device.state === 'device' : device.state === 'Booted';
const platformFor = (page: string): Platform => page === 'mac' ? 'mac' : page.startsWith('ios') ? 'ios' : 'android';

export default function ConnectDevice({ onDone, platform, onPlatform, lanAddresses, port, lanEnabled, records, mac, lan, onMacProxiesReverted, onTlsSettings, onFilterDevice }: Props) {
  const top = platformFor(platform);
  const [inventory, setInventory] = useState<DeviceInventory | null>(null);
  const [notice, setNotice] = useState<{ page: string; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [connectingId, setConnectingId] = useState('');
  const [site, setSite] = useState<SetupSite | null>(null);
  const [pairingQr, setPairingQr] = useState('');
  const [baselines, setBaselines] = useState<Partial<Record<Platform, number>>>(() => ({ [top]: Date.now() }));
  const lock = useRef(false);
  const pairingActive = useRef(false);
  const api = window.streamglass;

  const baseline = baselines[top] ?? Infinity;
  const message = notice?.page === platform ? notice.text : '';
  const setMessage = (text: string) => setNotice({ page: platform, text });
  const changePlatform = (page: string) => {
    const next = platformFor(page);
    const startedAt = Date.now();
    setBaselines(current => current[next] === undefined ? { ...current, [next]: startedAt } : current);
    if (page !== platform) setNotice(null);
    onPlatform(page);
  };
  useEffect(() => {
    const startedAt = Date.now();
    setBaselines(current => current[top] === undefined ? { ...current, [top]: startedAt } : current);
  }, [top]);
  // Each platform opens on its real-device guide; explicit simulator/emulator links still work.
  const real = platform === 'iosDevice' || platform === 'androidDevice';
  const metro = !!inventory && (inventory.metro.mode === 'always' || (inventory.metro.mode === 'auto' && inventory.metro.running));
  const wifiMetro = metro && inventory?.metro.running === true;
  const ip = inventory?.lan.address ?? lanAddresses[0] ?? '';
  const proxyPort = inventory?.lan.proxyPort ?? port;
  const lanOn = inventory?.lan.enabled ?? site?.lanEnabled ?? lanEnabled;
  const host = ip.includes(':') ? `[${ip}]` : ip;
  const setupUrl = inventory?.lan.setupUrl || (site?.running && site.port && ip ? `http://${host}:${site.port}/` : '');

  useEffect(() => {
    const status = inventory?.pairing;
    if (!pairingActive.current || !status || !['connected', 'error', 'cancelled'].includes(status.status)) return;
    pairingActive.current = false; setPairingQr('');
    setMessage(status.message || (status.status === 'connected' ? 'Phone paired. Select Connect on its device card.' : status.status === 'error' ? 'Pairing failed or timed out. Check wireless debugging and try again.' : 'Pairing cancelled.'));
  }, [inventory?.pairing]);

  // Inventory is watched only while this dialog is open.
  useEffect(() => {
    let active = true, revision = 0;
    const receive = (value: DeviceInventory) => { revision++; if (active) { setInventory(value); setLoading(false); } };
    let off: (() => void) | undefined;
    const start = async () => {
      if (!api?.deviceInventory) { setLoading(false); return; }
      try {
        off = api.onDeviceInventory?.(receive);
        const before = revision;
        const value = await api.deviceInventory();
        if (!active) return;
        if (revision === before) receive(value);
        await api.watchDevices?.(true);
        if (!active) await api.watchDevices?.(false);
      } catch (error) { if (active) { setMessage(String(error)); setLoading(false); } }
    };
    void start();
    return () => { active = false; off?.(); void api?.watchDevices?.(false).catch(() => {}); if (pairingActive.current) void api?.cancelAdbPairing?.().catch(() => {}); };
  }, []);
  useEffect(() => {
    let active = true;
    const poll = async () => { try { const value = await api?.setupSite?.(); if (active && value) setSite(value); } catch { /* The Wi-Fi guide stays usable without setup-site IPC. */ } };
    void poll(); const timer = setInterval(() => void poll(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const stopPairing = () => { if (!pairingActive.current) return; pairingActive.current = false; setPairingQr(''); void api?.cancelAdbPairing?.().catch(() => {}); };
  useEffect(() => { if (!(top === 'android' && real)) stopPairing(); }, [top, real]);

  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { lock.current = false; setBusy(false); setConnectingId(''); }
  };
  const connect = async (device: Device) => {
    if (!api?.connectDevice) { setMessage(unavailable); return; }
    setConnectingId(deviceId(device));
    const result = await api.connectDevice({ ...requestFor(device), metro }); setInventory(result.inventory); setMessage(result.message);
  };
  const revert = async (device: Device) => {
    if (!api?.disconnectDevice) { setMessage(unavailable); return; }
    const result = await api.disconnectDevice(requestFor(device)); setInventory(result.inventory); setMessage(result.message);
  };
  const rebootSimulator = async (device: IosSimulator) => {
    if (!api?.rebootSimulator) return;
    setMessage(`Rebooting ${device.name}…`);
    const result = await api.rebootSimulator({ platform: 'ios-simulator', id: device.udid });
    setInventory(result.inventory);
    setMessage(result.message);
  };
  const setOptions = (patch: Parameters<NonNullable<NonNullable<Window['streamglass']>['setDeviceOptions']>>[0]) => void run(async () => {
    if (!api?.setDeviceOptions) { setMessage(unavailable); return; }
    setInventory(await api.setDeviceOptions(patch));
  });
  const turnOnLan = () => void run(async () => {
    const next = await api?.setupSite?.({ enableLan: true });
    if (next) { setSite(next); if (next.error) setMessage(next.error); }
    if (api?.deviceInventory) setInventory(await api.deviceInventory());
  });
  const startPairing = () => void run(async () => {
    pairingActive.current = true;
    try { const result = await api?.startAdbPairing?.(); if (result && pairingActive.current) { setPairingQr(result.qrText); if (result.message) setMessage(result.message); } } catch (error) { pairingActive.current = false; throw error; }
  });

  const proxiedEmulators = inventory?.android.filter(d => d.kind === 'emulator' && d.connection).length ?? 0;
  const card = (device: Device) => <DeviceCard key={deviceId(device)} soleProxiedEmulator={proxiedEmulators === 1} device={device} records={records} baseline={baseline} metro={metro} options={inventory?.options}
    connecting={connectingId === deviceId(device)} busy={busy} canConnect={!!api?.connectDevice} canRevert={!!api?.disconnectDevice} canConfirm={!!api?.confirmUserCert} canReopen={!!api?.reopenCertInstaller}
    actions={{
      connect: () => void run(() => connect(device)), revert: () => void run(() => revert(device)), filter: id => onFilterDevice?.(id),
      reboot: !('serial' in device) && api?.rebootSimulator ? () => void run(() => rebootSimulator(device)) : undefined,
      confirm: () => void run(async () => { const next = await api?.confirmUserCert?.({ platform: 'android', id: deviceId(device) }); if (next) setInventory(next); }),
      reopen: () => void run(async () => { await api?.reopenCertInstaller?.({ platform: 'android', id: deviceId(device) }); }),
    }}/>;
  const automated: Device[] = top === 'ios' ? inventory?.iosSimulators.filter(d => d.state === 'Booted') ?? [] : inventory?.android.filter(d => d.kind === 'emulator') ?? [];
  const connectAll = () => void run(async () => { for (const device of automated) if (!device.connection && online(device)) await connect(device); });
  const revertAll = () => void run(async () => {
    const result = await api?.revertAllDevices?.();
    if (result) {
      setInventory(result.inventory);
      setMessage(result.message);
      if (top === 'mac') await onMacProxiesReverted();
    }
  });

  const lanBar = <div className="ds-lan"><WifiIcon/>{lanOn
    ? <><div className="ds-proxy-endpoint">
      <span>Proxy host <code>{ip || 'Unavailable'}</code></span>
      <span>Proxy port <code>{proxyPort}</code></span>
    </div><span className="ds-spacer"/><span className="ds-chip ok">Local network access on</span></>
    : <><span>Real devices reach Streamglass over Wi-Fi. Local network access is off.{ip ? <> This Mac: <code>{ip}</code></> : ' Join the same Wi-Fi network as the phone to get a LAN address.'}</span><span className="ds-spacer"/><button type="button" className="primary ds-sm" disabled={busy || !api?.setupSite} onClick={turnOnLan}>Turn on</button></>}</div>;
  const metroCallout = metro && <Callout tone="info">{inventory?.metro.running ? 'React Native detected: Metro is running' : 'Metro steps are enabled; waiting for Metro'} on <code>:8081</code>. Connected devices can load the JS bundle from this Mac.</Callout>;
  const partial = !!inventory && (!api?.connectDevice || !api?.disconnectDevice || !api?.watchDevices || !api?.onDeviceInventory);
  const platforms = [{ id: 'mac', label: 'This Mac' }, { id: 'ios', label: 'iOS' }, { id: 'android', label: 'Android' }] as const;
  const pages = top === 'ios' ? [{ id: 'iosDevice', label: 'Real device' }, { id: 'iosSimulator', label: 'Simulator' }] : [{ id: 'androidDevice', label: 'Real device' }, { id: 'androidEmulator', label: 'Emulator' }];

  return <div className="connect-device"><div className="ds-scroll"><AnimatedHeight>
    <div className="ds-navigation">
      {top !== 'mac' && <SubTabs label={`${top === 'ios' ? 'iOS' : 'Android'} device type`} value={platform} items={pages} onChange={changePlatform}/>}
      <div className="ds-platforms"><Segmented label="Platform" value={top} items={[...platforms]} onChange={value => changePlatform(value === 'mac' ? 'mac' : value === 'ios' ? 'iosDevice' : 'androidDevice')}/></div>
    </div>
    <div id="ds-page" role={top === 'mac' ? undefined : 'tabpanel'} aria-labelledby={top === 'mac' ? undefined : `ds-tab-${platform}`} className="ds-body">
      {top !== 'mac' && message && <p className="ds-message" role="status">{message}</p>}
      {top === 'mac' ? <ThisMacPage {...mac} records={records} port={port} baseline={baseline} busy={busy || mac.busy} onTlsSettings={onTlsSettings}/> : <>
        {!inventory && <p className="muted" role="status">{loading ? 'Checking connected devices…' : unavailable}</p>}
        {partial && <p className="muted" role="status">Some device automation is unavailable in this desktop version. The Wi-Fi guide remains available.</p>}
        {real
          ? <>{lanBar}<RealDevicePage key={top} os={top as 'ios' | 'android'} inventory={inventory} ip={ip} proxyPort={proxyPort} lanOn={lanOn} setupUrl={setupUrl} fingerprint={site?.fingerprint} siteError={site?.error} records={records} baseline={baseline} metro={wifiMetro} lan={lan} onFilterDevice={onFilterDevice} onRevert={api?.disconnectDevice ? device => void run(() => revert(device)) : undefined}
            renderCard={card as (device: AndroidDevice) => ReactNode} pairingQr={pairingQr} canPair={!!api?.startAdbPairing} busy={busy} onPair={startPairing} onCancelPair={() => void run(async () => { await api?.cancelAdbPairing?.(); pairingActive.current = false; setPairingQr(''); })} onShortcutsToggle={open => { if (!open) stopPairing(); }}/></>
          : <><AutomatedPage metroCallout={metroCallout} os={top as 'ios' | 'android'} inventory={inventory} devices={automated} busy={busy} working={!!connectingId} metro={metro} canConnect={!!api?.connectDevice} onConnectAll={connectAll} renderCard={card as (device: Device) => ReactNode}/></>}
        <DeviceOptions inventory={inventory} metro={metro} disabled={busy || !api?.setDeviceOptions} onChange={setOptions} onTlsSettings={onTlsSettings}/>
      </>}
      {top === 'mac' && message && <p className="ds-mac-notice" role="status">{message}</p>}
    </div>
  </AnimatedHeight></div>
    <div className="connect-nav"><button type="button" className="ghost" disabled={busy || mac.busy || !api?.revertAllDevices} onClick={revertAll}>Revert all proxies</button><span className="ds-spacer"/><button type="button" onClick={onDone}>Done</button></div>
  </div>;
}
