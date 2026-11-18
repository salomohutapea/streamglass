import type { AndroidDevice, IosSimulator } from './device-setup-types';
import type { DeviceEvidence } from './device-setup-evidence.mjs';
export type Tone = 'ok' | 'warn' | 'err' | 'spin' | 'idle';
export type Chip = { label: string; tone?: 'ok' | 'acc' };
export type CertKind = 'running' | 'none' | 'rejected' | 'failed' | 'auto' | 'tap' | 'trusted' | 'installed' | 'waiting';
export type MetroKind = 'hidden' | 'bundle' | 'none' | 'running' | 'failed' | 'ready' | 'waiting';
export function deviceHeading(device: AndroidDevice | IosSimulator): { name: string; sub: string; chips: Chip[]; icon: 'emulator' | 'phone' };
export function describeDevice(device: AndroidDevice | IosSimulator, context?: { evidence?: Pick<DeviceEvidence, 'https' | 'tlsVerified' | 'metro' | 'traffic'>; metro?: boolean; connecting?: boolean }): {
  state: 'idle' | 'connecting' | 'connected' | 'partial'; cert: CertKind; metro: MetroKind; connected: boolean; canRetry: boolean;
  tones: { proxy: Tone; cert: Tone; metro: Tone; traffic: Tone }; pills: [string, Tone][];
};
