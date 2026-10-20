export type Segment = { key: string; label: string; ms: number; offsetPct: number; widthPct: number };
export type GapSummary = { count: number; minMs: number; avgMs: number; p95Ms: number; maxMs: number };
export function waterfallSegments(timings: Record<string, number> | undefined | null): Segment[];
export function median(values: number[]): number | undefined;
export function longGapThreshold(gaps: number[]): number;
export function gapSummary(gaps: number[]): GapSummary | undefined;
export function eventGaps(events: { gapMs?: number; receivedAt?: number }[], headersAtMs?: number): (number | undefined)[];
export function formatMs(ms: number): string;
