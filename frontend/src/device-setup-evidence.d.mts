export type SetupRecord = { id: string; device?: string; deviceId?: string; devicePlatform?: string|null; clientIsLocal?: boolean; startedAt?: number|string; url: string; sslInspected?: boolean; kind?: string; isEncrypted?: boolean; status?: number; statusCode?: number; tlsFailure?: unknown; responseSize?: number|null; durationMs?: number|null; duration?: number|null; application?: { name: string } | null; host?: string };
export type DeviceEvidence = { traffic: boolean; tlsVerified: boolean; https: 'error'|'ok'|'pending'; metro: boolean; count: number; bundle: { name: string; status: number; size: number|null; durationMs: number|null } | null; failure: { host: string | null; app: string | null } | null; first: { at: number; app: string|null } | null };
export function deviceEvidence(records: SetupRecord[], match?: { ids?: string[]; addresses?: string[]; platform?: string; since?: number }): DeviceEvidence;
export function androidRecordIds(device: { kind: string; serial: string; name: string }, options?: { soleProxiedEmulator?: boolean }): string[];
export function simulatorRuntimeLabel(simulator: { name?: string; runtime?: string }): string;
export function formatBytes(bytes: number | null | undefined): string;
export function formatAgo(at: number, now?: number): string;
