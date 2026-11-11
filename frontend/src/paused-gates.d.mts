export type EndedGate<G> = { gate: G; reason: string; pausedMs: number };
export function endedGates<G extends { recordId: string; pausedAt?: number }>(seen: Map<string, G>, live: Map<string, G>, resolved: Set<string>, records?: { id: string; state?: string; error?: string | null }[], now?: number): EndedGate<G>[];
export function isDisconnect(reason: string): boolean;
export function pausedEntries<G extends { pausedAt?: number }>(live: G[], ended: EndedGate<G>[]): { gate: G; ended: EndedGate<G> | null }[];
export function endedConsequence(stage: string): string;
