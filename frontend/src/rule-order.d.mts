export function upsertRule<T extends { id: string }>(rules: T[], updated: T): T[];
