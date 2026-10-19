export function groupJourneys(records: any[], analysis: Record<string,any>, now?:number): any[];
export function assertionCounts(rows: Record<string,any>): {pass:number;fail:number;pending:number;unknown:number};
export function flattenJsonPaths(value: unknown, options?:{limit?:number;maxDepth?:number;maxIndex?:number}): {path:string;value:unknown}[];
export function detectCorrelationKeys(captures: any[], options?:{limit?:number}): {kind:'path'|'header';key:string;count:number;sample:string}[];
export function durationStats(values: (number|null|undefined)[]): {count:number;min:number;max:number;avg:number;p95:number}|null;
