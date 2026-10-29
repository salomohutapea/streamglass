import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Folder, FolderMinus, FolderPlus, ListFilter, MoreHorizontal, Trash2 } from 'lucide-react';
import './rule-list.css';

type Rule = { id: string; name?: string; enabled: boolean; pattern: string; method: string; stages: string[]; script?: string; breakpoint?: boolean; folderId?: string };
type FolderOption = { id: string; name: string };
export const ruleDragType = 'application/x-streamglass-rule';
type MenuState = { x: number; y: number; rule: Rule; label: string; opener: HTMLElement | null };

// Minimal accessible popup menu: Escape or an outside press closes it, arrow keys move between items.
export function PopupMenu({ x, y, label, opener, onClose, children }: { x: number; y: number; label: string; opener: HTMLElement | null; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = () => { onClose(); opener?.focus(); };
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input,[role^="menuitem"]')?.focus();
    const away = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener('mousedown', away); document.addEventListener('contextmenu', away);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('contextmenu', away); };
  }, []);
  const style = { left: Math.max(4, Math.min(x, window.innerWidth - 236)), top: Math.max(4, Math.min(y, window.innerHeight - 200)) };
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { onClose(); return; }
    if (event.target instanceof HTMLInputElement) return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (move) { event.preventDefault(); items[(index + move + items.length) % items.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus(); }
  }
  return <div ref={ref} className="rule-menu" role="menu" aria-label={label} style={style} onKeyDown={onKeyDown}>{children}</div>;
}

// An untitled rule is headed by the last segment of its URL pattern, such as "dateflow" for *flight/dateflow.
const patternName = (pattern: string) => pattern.split(/[?#]/)[0].split('/').map(part => part.replace(/\*/g, '')).filter(Boolean).pop() || pattern;

export default function RuleList({ rules, emptyMessage, folders = [], onToggle, onEdit, onDelete, onMove, onCreateFolderAndMove }: {
  rules: Rule[];
  emptyMessage: string;
  folders?: FolderOption[];
  onToggle: (rule: Rule, enabled: boolean) => void;
  onEdit: (rule: Rule) => void;
  onDelete: (rule: Rule) => void;
  onMove?: (rule: Rule, folderId: string | null) => void;
  onCreateFolderAndMove?: (rule: Rule, name: string) => void;
}) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const canMove = Boolean(onMove && onCreateFolderAndMove);
  function open(rule: Rule, label: string, x: number, y: number, opener: HTMLElement | null) { setChoosing(false); setCreating(false); setName(''); setMenu({ x, y, rule, label, opener }); }
  const close = () => setMenu(null);
  return <div className="compact-rule-list">
    {rules.map(rule => {
      const ruleName = rule.name?.trim();
      const method = rule.method || '*';
      const customName = ruleName && !/^Untitled (rule|script)$/.test(ruleName) && ruleName !== rule.pattern && ruleName !== `${method} ${rule.pattern}`;
      const label = customName ? ruleName : `${method} ${rule.pattern}`;
      return <div className="compact-rule-row" key={rule.id} draggable={canMove} onDragStart={canMove ? event => { event.dataTransfer.setData(ruleDragType, rule.id); event.dataTransfer.effectAllowed = 'move'; event.currentTarget.classList.add('dragging'); } : undefined} onDragEnd={canMove ? event => event.currentTarget.classList.remove('dragging') : undefined} onContextMenu={canMove ? event => { event.preventDefault(); open(rule, label, event.clientX, event.clientY, event.currentTarget.querySelector('.compact-rule-more')); } : undefined}>
        <input aria-label={`Enable ${label}`} type="checkbox" checked={rule.enabled} onChange={event => onToggle(rule, event.target.checked)} />
        <button className="compact-rule-detail" aria-label={`Edit ${label}`} onClick={() => onEdit(rule)}>
          {customName ? <strong className="compact-rule-name" title={ruleName}>{ruleName}</strong> : <span className="compact-rule-fallback">{patternName(rule.pattern)}</span>}
          <span className="compact-rule-line"><span className="compact-rule-target"><span className="compact-rule-method">{method === '*' ? 'ANY' : method}</span><code title={rule.pattern}>{rule.pattern}</code></span>
          <span className="compact-rule-stages">{rule.stages.map(stage => <span key={stage} title={stage === 'event' ? 'Each SSE event' : undefined}>{stage === 'request' ? 'Request' : stage === 'response' ? 'Response' : stage === 'event' ? 'SSE' : stage}</span>)}</span></span>
        </button>
        {canMove && <button className="icon-button compact-rule-more" title={`Rule actions for ${label}`} aria-label={`Rule actions for ${label}`} aria-haspopup="menu" aria-expanded={menu?.rule.id === rule.id} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); open(rule, label, box.left - 190, box.bottom + 2, event.currentTarget); }}><MoreHorizontal /></button>}
        <button className="icon-button compact-rule-delete" title={`Delete ${label}`} aria-label={`Delete ${label}`} onClick={() => onDelete(rule)}><Trash2 /></button>
      </div>;
    })}
    {!rules.length && <div className="rule-empty"><ListFilter aria-hidden="true" /><p>{emptyMessage}</p></div>}
    {menu && canMove && <PopupMenu x={menu.x} y={menu.y} label={`Actions for ${menu.label}`} opener={menu.opener} onClose={close}>
      {!creating && <>
        <button role="menuitem" aria-haspopup="menu" aria-expanded={choosing} onClick={() => setChoosing(!choosing)}><Folder size={13} />Move to folder<span aria-hidden="true">{choosing ? '▾' : '▸'}</span></button>
        {choosing && <div className="rule-menu-sub" role="group" aria-label="Folders">
          {folders.map(folder => <button key={folder.id} role="menuitemradio" aria-checked={menu.rule.folderId === folder.id} onClick={() => { onMove!(menu.rule, folder.id); close(); }}><span title={folder.name}>{folder.name}</span>{menu.rule.folderId === folder.id && <span aria-hidden="true">✓</span>}</button>)}
          <button role="menuitem" onClick={() => setCreating(true)}><FolderPlus size={13} />New folder…</button>
        </div>}
        {menu.rule.folderId && <button role="menuitem" onClick={() => { onMove!(menu.rule, null); close(); }}><FolderMinus size={13} />Remove from folder</button>}
      </>}
      {creating && <form className="rule-menu-form" onSubmit={event => { event.preventDefault(); const trimmed = name.trim(); if (!trimmed) return; onCreateFolderAndMove!(menu.rule, trimmed); close(); }}>
        <label>New folder name<input aria-label="New folder name" maxLength={128} value={name} onChange={event => setName(event.target.value)} /></label>
        <div><button type="button" onClick={() => setCreating(false)}>Back</button><button className="primary" type="submit" disabled={!name.trim()}>Create and move</button></div>
      </form>}
    </PopupMenu>}
  </div>;
}
