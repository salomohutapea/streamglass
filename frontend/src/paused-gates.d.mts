export type EndedGate<G> = { gate: G; reason: string; pausedMs: number };
export function endedGates<G extends { recordId: string; pausedAt?: number }>(seen: Map<string, G>, live: Map<string, G>, resolved: Set<string>, records?: { id: string; state?: string; error?: string | null }[], now?: number): EndedGate<G>[];
export function isDisconnect(reason: string): boolean;
