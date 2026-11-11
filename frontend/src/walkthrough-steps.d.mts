export type WalkthroughStop = { id: string; targets: string[]; title: string; text: string; emptyText?: string; sidebar?: boolean };
export type Box = { left: number; top: number; width: number; height: number };
export const walkthroughStops: WalkthroughStop[];
export function availableStops(stops: WalkthroughStop[], hasTarget: (selector: string) => boolean): WalkthroughStop[];
export function unionRect(rects: Box[], viewport: { width: number; height: number }, inset?: number): Box | null;
export function placeTooltip(target: Box, tip: { width: number; height: number }, viewport: { width: number; height: number }, gap?: number, margin?: number): { side: 'below' | 'above' | 'right' | 'left'; left: number; top: number };
