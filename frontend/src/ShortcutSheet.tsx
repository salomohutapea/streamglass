import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import './command-palette.css';

const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const mod = mac ? '⌘' : 'Ctrl';
const shift = mac ? '⇧' : 'Shift';

export type ShortcutRow = { keys: string; label: string; planned?: boolean };
export const shortcutGroups: { name: string; rows: ShortcutRow[] }[] = [
  { name: 'General', rows: [
    { keys: `${mod} K`, label: 'Command palette' },
    { keys: `${mod} /`, label: 'Keyboard shortcuts' },
    { keys: `${mod} ,`, label: 'Settings' },
    { keys: `${mod} ${shift} D`, label: 'Connect device' },
    { keys: `${mod} F`, label: 'Find in traffic' },
    { keys: `${mod} ${shift} S`, label: 'Sessions' },
  ] },
  { name: 'Capture', rows: [
    { keys: `${mod} ${shift} P`, label: 'Pause / resume capture' },
    { keys: `${mod} ${shift} K`, label: 'Start / stop proxy' },
  ] },
  { name: 'Table', rows: [
    { keys: '↑ ↓', label: 'Move selection', planned: true },
    { keys: `${mod}-click / ${shift}-click`, label: 'Multi-select', planned: true },
    { keys: `${mod} A`, label: 'Select all', planned: true },
    { keys: '⌫', label: 'Delete selected', planned: true },
    { keys: `${mod} C`, label: 'Copy as cURL', planned: true },
    { keys: 'Esc', label: 'Clear search', planned: true },
    { keys: 'Enter / Space', label: 'Select row' },
    { keys: `${shift} F10`, label: 'Row context menu' },
  ] },
  { name: 'Inspector', rows: [
    { keys: `${mod} 1`, label: 'Overview' },
    { keys: `${mod} 2`, label: 'Request' },
    { keys: `${mod} 3`, label: 'Response' },
    { keys: `${mod} 4`, label: 'SSE events' },
    { keys: `${mod} 5`, label: 'Script console' },
    { keys: `${mod} ${shift} I`, label: 'Detach inspector' },
  ] },
  { name: 'Rules', rows: [
    { keys: `${mod} K`, label: 'Breakpoint rules' },
    { keys: `${mod} K`, label: 'JavaScript rules' },
  ] },
  { name: 'Tools', rows: [
    { keys: `${mod} K`, label: 'Tools tabs' },
    { keys: '← →', label: 'Resize splitter' },
  ] },
];

// Shortcut lookup for palette rows, keyed by menu command id.
export const commandShortcuts: Record<string, string> = {
  'command-palette': `${mod} K`, 'shortcut-sheet': `${mod} /`, settings: `${mod} ,`, 'connect-device': `${mod} ${shift} D`,
  'focus-search': `${mod} F`, 'daily-sessions': `${mod} ${shift} S`, 'capture-toggle': `${mod} ${shift} P`, 'proxy-toggle': `${mod} ${shift} K`,
  'detach-inspector': `${mod} ${shift} I`,
};

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className="shortcut-sheet" aria-label="Keyboard shortcuts" onClose={onClose} onClick={e => { if (e.target === ref.current) onClose(); }}>
    <header><h2>Keyboard shortcuts</h2><button type="button" className="icon-button" aria-label="Close keyboard shortcuts" onClick={onClose}><X size={14} /></button></header>
    <div className="shortcut-grid">
      {shortcutGroups.map(group => <section key={group.name} aria-label={group.name}>
        <h3>{group.name}</h3>
        <dl>{group.rows.map(row => <div key={`${row.keys}-${row.label}`}><dt>{row.label}</dt><dd><kbd>{row.keys}</kbd></dd></div>)}</dl>
      </section>)}
    </div>
  </dialog>;
}
