export function prepareJson(value: unknown): { text: string; isJson: boolean };
export function jsonPage(text: string, start?: number): { text: string; start: number; end: number; hasNext: boolean };
export function jsonHighlights(text: string, start: number, end: number): { text: string; kind: string }[];
export type JsonContainer = { start: number; end: number; kind: string };
export function jsonContainers(text: string): JsonContainer[];
export function foldJson(text: string, ranges: JsonContainer[], collapsed: Set<number>): { text: string; ranges: (JsonContainer & { displayStart: number })[] };
export function replaceJsonContainer(text: string, range: JsonContainer, replacement: string): string;
