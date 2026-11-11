export type TreeRule = { id: string; enabled: boolean; folderId?: string; order?: number };
export type TreeFolder = { id: string; name: string; parentId?: string; enabled?: boolean; expanded?: boolean; order?: number };
export type TreeRef = { type: 'rule' | 'folder'; id: string };
export type RuleRow<R, F> =
  | { type: 'rule'; id: string; depth: number; parentId: string | null; order: number; item: R }
  | { type: 'folder'; id: string; depth: number; parentId: string | null; order: number; item: F; open: boolean; count: number; state: 'on' | 'off' | 'mixed' };
export function ruleRows<R extends TreeRule, F extends TreeFolder>(rules: R[], folders: F[], visible?: (rule: R) => boolean): RuleRow<R, F>[];
export function folderDescendants(folders: TreeFolder[], id: string): Set<string>;
export function folderPath(folders: TreeFolder[], id: string): string;
export function dropPlacement(rules: TreeRule[], folders: TreeFolder[], dragged: TreeRef, target: TreeRef, zone: 'before' | 'after' | 'inside'): { parentId: string | null; order: number } | null;
export function stepPlacement(rules: TreeRule[], folders: TreeFolder[], item: TreeRef, direction: 1 | -1): { parentId: string | null; order: number } | null;
