export type PaletteCommandLike = { id: string; title: string; keywords?: string };
export function fuzzyScore(query: string, text: string): { score: number; indexes: number[] } | null;
export function filterCommands<T extends PaletteCommandLike>(commands: T[], query: string, recentIds?: string[]): { command: T; order: number; indexes: number[]; score?: number }[];
export function pushRecent(recentIds: string[], id: string, limit?: number): string[];
