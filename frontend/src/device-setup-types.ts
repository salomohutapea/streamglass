/** Device setup preload contract. Optional methods allow older desktop bridges. */
export type StepStatus = 'ok' | 'pending' | 'running' | 'error' | 'skipped' | 'off';
export type DeviceConnection = {
  proxy: { status: StepStatus; value?: string };
  cert: { status: StepStatus; mode?: 'system' | 'user' | 'simulator'; detail?: string; file?: string };
  metro: { status: StepStatus; detail?: string };
  connectedAt: number;
};
export type AndroidDevice = {
  serial: string; kind: 'emulator' | 'physical'; transport: 'emulator' | 'usb' | 'wifi';
  address?: string | null; // LAN IP of a wireless-debugging phone, when known
  state: 'device' | 'unauthorized' | 'offline'; name: string; apiLevel: number | null; release: string | null;
  image: 'google_apis' | 'google_play' | 'aosp' | 'unknown'; rootable: boolean; connection: DeviceConnection | null;
};
export type IosSimulator = { udid: string; name: string; runtime: string; state: string; connection: DeviceConnection | null };
export type DeviceInventory = {
  adbAvailable: boolean; simctlAvailable: boolean; android: AndroidDevice[]; iosSimulators: IosSimulator[];
  metro: { running: boolean; port: 8081; mode: 'auto' | 'always' | 'off' };
  lan: { enabled: boolean; address: string | null; proxyPort: number; setupUrl: string | null };
  pairing?: { status: 'waiting' | 'paired' | 'connected' | 'error' | 'cancelled'; name?: string; message?: string };
  options: { reapply: boolean; revertOnQuit: boolean; autoConnect: boolean };
};
export type DeviceRequest = { platform: 'android' | 'ios-simulator'; id: string };
export type SetupSite = { lanEnabled: boolean; port: number | null; running: boolean; fingerprint?: string | null; error?: string };
export type AdbPairing = { name: string; qrText: string; message?: string };
export interface DeviceSetupApi {
  deviceInventory?(): Promise<DeviceInventory>;
  watchDevices?(on: boolean): Promise<void>;
  onDeviceInventory?(callback: (inventory: DeviceInventory) => void): () => void;
  connectDevice?(request: DeviceRequest & { metro?: boolean }): Promise<{ ok: boolean; connection: DeviceConnection; message: string; inventory: DeviceInventory }>;
  disconnectDevice?(request: DeviceRequest): Promise<{ ok: boolean; message: string; inventory: DeviceInventory }>;
  revertAllDevices?(): Promise<{ ok: boolean; message: string; inventory: DeviceInventory }>;
  setDeviceOptions?(patch: Partial<DeviceInventory['options']> & { metroMode?: DeviceInventory['metro']['mode'] }): Promise<DeviceInventory>;
  confirmUserCert?(request: { platform: 'android'; id: string }): Promise<DeviceInventory>;
  reopenCertInstaller?(request: { platform: 'android'; id: string }): Promise<void>;
  startAdbPairing?(): Promise<AdbPairing>;
  cancelAdbPairing?(): Promise<void>;
  setupSite?(options?: { enableLan?: boolean }): Promise<SetupSite>;
}
