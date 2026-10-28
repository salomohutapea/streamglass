import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { fieldsColumnValue, type FieldResult } from './custom-fields.mjs';

export type TrafficRecord = { id: string; method: string; url: string; startedAt?: string | number; kind?: 'request' | 'tunnel'; isSSE?: boolean; eventCount?: number; events?: unknown[]; state?: string; status?: number; statusCode?: number; duration?: number; durationMs?: number|null; serverMs?: number|null; device?:string; deviceId?:string; application?:{name:string}|null; fields?: FieldResult[]; response?: { headers?: unknown } };
export type SortColumn = 'method' | 'request' | 'time' | 'status' | 'duration' | 'serverTime' | 'device' | 'application' | 'protocol' | 'host' | 'path' | 'events' | 'fields';
export {isSSE} from './traffic-preferences.mjs';
export function startedAtMs(value: TrafficRecord['startedAt']): number | undefined {
  if (value == null || value === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  const result = Number.isFinite(numeric) ? (Math.abs(numeric) < 1e12 ? Math.round(numeric * 1000) : numeric) : Date.parse(String(value));
  return Number.isFinite(result) && Math.abs(result) <= 8.64e15 ? result : undefined;
}
export function requestTime(value: TrafficRecord['startedAt']) {
  const timestamp = startedAtMs(value);
  if (timestamp === undefined) return '—';
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}
export function statusClass(record: TrafficRecord) { const code = record.kind === 'tunnel' ? 0 : Number(record.status ?? record.statusCode ?? 0); return code >= 100 && code < 600 ? String(Math.floor(code / 100)) : undefined; }
export function protocol(record: TrafficRecord) { return record.kind === 'tunnel' || record.url.toLowerCase().startsWith('https:') ? 'HTTPS' : 'HTTP'; }
export {matchesQuickFilters} from './traffic-preferences.mjs';
export function columnValue(record: TrafficRecord, column: SortColumn): string | number | undefined {
  if (column === 'host' || column === 'path') { try { const url = new URL(record.url); return column === 'host' ? url.host : url.pathname + url.search; } catch { return undefined; } }
  if (column === 'events') return record.eventCount ?? record.events?.length;
  if (column === 'fields') return fieldsColumnValue(record.fields);
  if (column === 'time') return startedAtMs(record.startedAt);
  if (column === 'request') return record.url;
  if (column === 'status') return record.status ?? record.statusCode;
  if (column === 'duration') return record.durationMs ?? record.duration;
  if (column === 'serverTime') return record.serverMs ?? undefined;
  if (column === 'device') return record.deviceId ?? record.device;
  if (column === 'application') return record.application?.name;
  if (column === 'protocol') return protocol(record);
  return record.method;
}
export function sortRecords<T extends TrafficRecord>(records: T[], column: SortColumn, direction: 'asc' | 'desc') {
  return records.map((record, index) => ({record, index})).sort((a, b) => {
    const left = columnValue(a.record, column);
    const right = columnValue(b.record, column);
    if (left === undefined) return right === undefined ? a.index - b.index : 1;
    if (right === undefined) return -1;
    const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    return order ? order * (direction === 'asc' ? 1 : -1) : a.index - b.index;
  }).map(item => item.record);
}
export function RecordContextMenu({x, y, children, onClose, returnFocus, label="Request actions"}: {label?:string; x:number; y:number; children:ReactNode; onClose:()=>void; returnFocus:HTMLElement}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    const enabled = () => Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    (enabled()[0] ?? menu).focus();
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) onClose(); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); onClose(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = enabled(), index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('pointerdown', outside);
    menu.addEventListener('keydown', keydown);
    window.addEventListener('resize', onClose);
    return () => { document.removeEventListener('pointerdown', outside); menu.removeEventListener('keydown', keydown); window.removeEventListener('resize', onClose); if (menu.contains(document.activeElement) || document.activeElement === document.body) returnFocus.focus(); };
  }, [x, y, onClose, returnFocus]);
  return <div ref={ref} role="menu" aria-label={label} tabIndex={-1} className="record-context-menu" style={{left:x,top:y}}>{children}</div>;
}
