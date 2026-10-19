export type FilterScope = 'url' | 'request' | 'response' | 'event';
export type FilterJoiner = 'and' | 'or';
export type ExtraCondition = { joiner: FilterJoiner; scope: FilterScope; mode: string; filter: string };
export const MAX_CONDITIONS: number;
export const MAX_EXTRA_CONDITIONS: number;
export function isActiveCondition(condition: { filter?: string } | null | undefined): boolean;
export function normalizeExtraConditions(value: unknown): ExtraCondition[];
export function combineConditionMatches(conditions: { joiner?: FilterJoiner; filter: string }[], idSets: (Set<string> | null | undefined)[]): Set<string> | null;
