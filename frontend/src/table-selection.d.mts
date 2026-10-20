export function toggleId(selected: ReadonlySet<string>, id: string): Set<string>;
export function rangeIds(orderedIds: string[], anchorId: string, targetId: string): Set<string>;
export function moveId(orderedIds: string[], currentId: string | null | undefined, key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'): string | null;
export function pruneIds(selected: Set<string>, validIds: string[]): Set<string>;
export function clickSelection(input: {orderedIds: string[]; selected: ReadonlySet<string>; anchor: string | null; id: string; shift?: boolean; toggle?: boolean}): {selected: Set<string>; anchor: string; primary: string};
