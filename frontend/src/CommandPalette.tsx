import { useEffect, useMemo, useRef, useState } from 'react';
import { filterCommands, pushRecent } from './command-match.mjs';
import { commandShortcuts } from './ShortcutSheet';
import './command-palette.css';

export type PaletteCommand = { id: string; title: string; group: string; keywords?: string; shortcut?: string; run: () => void };
type DeviceLike = { id: string }; type ViewLike = { id: string; name: string };

const recentKey = 'streamglass.palette.recent.v1';
const readRecent = (): string[] => { try { const v = JSON.parse(localStorage.getItem(recentKey) ?? '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 6) : []; } catch { return []; } };

// Commands route through the same menu-action ids as the application menu so validation and state checks stay in one place.
export function buildPaletteCommands(o: {
  menu: (id: string, payload?: any) => void; theme: string; sidebarPinned: boolean; paused: boolean; proxyRunning: boolean;
  savedViews: ViewLike[]; devices: DeviceLike[]; applyView: (id: string) => void; selectDevice: (id: string) => void;
  toggleSidebarPin: () => void; showTour: () => void; showShortcuts: () => void;
}): PaletteCommand[] {
  const m = (id: string, title: string, group: string, keywords?: string, payload?: any): PaletteCommand => ({ id, title, group, keywords, shortcut: commandShortcuts[id], run: () => o.menu(id, payload) });
  const tools: [string, string][] = [['map-local', 'Map Local'], ['map-remote', 'Map Remote'], ['rewrite-rules', 'Rewrite'], ['block-rules', 'Block'], ['network-profile', 'Network Conditioner'], ['daily-sessions', 'Sessions'], ['daily-journeys', 'Journeys'], ['daily-fields', 'Custom Fields'], ['daily-assertions', 'Assertions'], ['daily-repeat', 'Repeat'], ['daily-views', 'Saved filters'], ['daily-notes', 'Notes'], ['lab-compare', 'Compare'], ['lab-replay', 'Replay'], ['lab-scenarios', 'Scenarios'], ['lab-fixture', 'Create mock'], ['lab-share', 'Share'], ['lab-workspaces', 'Workspaces'], ['lab-codecs', 'Codecs'], ['lab-mcp', 'Agent (MCP)']];
  const platforms: [string, string][] = [['macos', 'This Mac'], ['ios-simulator', 'iOS Simulator'], ['ios-device', 'iOS Device'], ['android-emulator', 'Android Emulator'], ['android-device', 'Android Device']];
  return [
    ...tools.map(([id, name]) => m(id, `Tools: ${name}`, 'Tools', 'open tab')),
    m('breakpoints', 'Breakpoint rules', 'Rules', 'intercept pause'),
    m('scripts', 'JavaScript rules', 'Rules', 'script hook'),
    m('settings', 'Settings', 'General', 'preferences proxy port tls'),
    m('connect-device', 'Connect device', 'General', 'add pair'),
    ...platforms.map(([p, name]) => m(`setup-${p}`, `Set up ${name}`, 'Setup', 'certificate install', { platform: p })).map(c => ({ ...c, run: () => o.menu('open-device-setup', { platform: c.id.slice(6) }) })),
    m('proxy-toggle', o.proxyRunning ? 'Stop proxy' : 'Start proxy', 'Capture', 'server'),
    m('capture-toggle', o.paused ? 'Resume capture' : 'Pause capture', 'Capture', 'record rules'),
    m('clear-all', 'Clear all requests', 'Capture', 'delete remove'),
    { id: 'toggle-theme', title: `Switch to ${o.theme === 'dark' ? 'light' : 'dark'} theme`, group: 'View', keywords: 'appearance dark light', run: () => o.menu(o.theme === 'dark' ? 'theme-light' : 'theme-dark') },
    m('inspector-right', 'Inspector on right', 'View', 'layout'),
    m('inspector-below', 'Inspector below', 'View', 'layout'),
    { id: 'sidebar-pin', title: o.sidebarPinned ? 'Unpin sidebar' : 'Pin sidebar', group: 'View', keywords: 'toggle sidebar expand', run: o.toggleSidebarPin },
    m('focus-search', 'Focus search', 'General', 'find filter'),
    { id: 'welcome-tour', title: 'Show welcome tour', group: 'Help', keywords: 'onboarding intro', run: o.showTour },
    { id: 'shortcut-sheet', title: 'Keyboard shortcuts', group: 'Help', keywords: 'keys help', shortcut: commandShortcuts['shortcut-sheet'], run: o.showShortcuts },
    ...o.savedViews.map(v => ({ id: `view:${v.id}`, title: `Apply saved filter: ${v.name}`, group: 'Saved filters', keywords: 'filter view', run: () => o.applyView(v.id) })),
    ...o.devices.map(d => ({ id: `device:${d.id}`, title: `Filter to device: ${d.id}`, group: 'Devices', keywords: 'only show', run: () => o.selectDevice(d.id) })),
  ];
}

export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: PaletteCommand[] }) {
  const ref = useRef<HTMLDialogElement>(null), list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState(''), [active, setActive] = useState(0), [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) { setQuery(''); setActive(0); setRecent(readRecent()); dialog.showModal(); }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const results = useMemo(() => filterCommands(commands, query, recent), [commands, query, recent]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active, results]);
  function run(index: number) {
    const hit = results[index]?.command;
    if (!hit) return;
    try { localStorage.setItem(recentKey, JSON.stringify(pushRecent(readRecent(), hit.id))); } catch { /* recents are optional */ }
    onClose();
    setTimeout(() => hit.run(), 0);
  }
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (results.length) setActive(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  }
  const title = (text: string, indexes: number[]) => {
    if (!indexes.length) return text;
    const set = new Set(indexes);
    return [...text].map((ch, i) => set.has(i) ? <mark key={i}>{ch}</mark> : ch);
  };
  return <dialog ref={ref} className="command-palette" aria-label="Command palette" onClose={onClose} onClick={e => { if (e.target === ref.current) onClose(); }}>
    <input role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={results[active] ? `palette-${active}` : undefined} aria-label="Search commands" placeholder="Command…" autoComplete="off" spellCheck={false} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown} />
    <ul id="palette-list" role="listbox" aria-label="Commands" ref={list}>
      {results.map((r, i) => <li key={r.command.id} id={`palette-${i}`} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)} onClick={() => run(i)}>
        <span className="palette-title">{query ? title(r.command.title, r.indexes) : r.command.title}</span>
        <small>{!query && recent.includes(r.command.id) ? 'Recent' : r.command.group}</small>
        {r.command.shortcut && <kbd>{r.command.shortcut}</kbd>}
      </li>)}
      {!results.length && <li className="palette-empty" role="presentation">No match</li>}
    </ul>
  </dialog>;
}

// Global shortcuts for renderer windows; the application menu uses the same accelerators in Electron.
export function usePaletteShortcuts(openPalette: () => void, openSheet: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === 'k') { e.preventDefault(); openPalette(); }
      else if (e.key === '/') { e.preventDefault(); openSheet(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openPalette, openSheet]);
}
