import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { ChevronRight, Folder, FolderOpen, FolderPlus, ListFilter, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { PopupMenu } from './RuleList';
import { folderPath, type RuleRow, type TreeRef } from './rule-tree.mjs';
import './rule-list.css';

export type TableRule = { id: string; name?: string; enabled: boolean; pattern: string; method: string; stages: string[]; folderId?: string; order?: number };
export type TableFolder = { id: string; name: string; parentId?: string; enabled?: boolean; expanded?: boolean; order?: number };
type Row = RuleRow<TableRule, TableFolder>;
type Zone = 'before' | 'after' | 'inside';
const dragType = 'application/x-streamglass-rule-row';
const stages: [string, string][] = [['request', 'Request'], ['response', 'Response'], ['event', 'SSE']];

// An untitled rule is named by the last segment of its URL pattern, such as "dateflow" for *flight/dateflow.
const patternName = (pattern: string) => pattern.split(/[?#]/)[0].split('/').map(part => part.replace(/\*/g, '')).filter(Boolean).pop() || pattern;
export function ruleLabel(rule: TableRule) {
  const name = rule.name?.trim(), method = rule.method || '*';
  const custom = name && !/^Untitled (rule|script)$/.test(name) && name !== rule.pattern && name !== `${method} ${rule.pattern}`;
  return { custom: Boolean(custom), text: custom ? name! : patternName(rule.pattern), label: custom ? name! : `${method} ${rule.pattern}` };
}

/** Rules and folders in one compact table. Folders are rows that expand in place; rows drag to reorder or to move into
 *  a folder (Option+Up/Down does the same from the keyboard). Sorting is off while a search is filtering the list. */
export default function RuleTable({ rows, folders, searching, emptyMessage, folderForm, onFolderForm, onSaveFolder, onToggleRule, onToggleFolder, onExpand, onEdit, onDeleteRule, onDeleteFolder, onAddRule, onPlace, onStep }: {
  rows: Row[]; folders: TableFolder[]; searching: boolean; emptyMessage: string;
  folderForm: { id?: string; parentId?: string | null; name: string } | null;
  onFolderForm(form: { id?: string; parentId?: string | null; name: string } | null): void; onSaveFolder(): void;
  onToggleRule(rule: TableRule, enabled: boolean): void; onToggleFolder(folder: TableFolder, enabled: boolean): void; onExpand(folder: TableFolder, expanded: boolean): void;
  onEdit(rule: TableRule): void; onDeleteRule(rule: TableRule): void; onDeleteFolder(folder: TableFolder): void; onAddRule(folderId: string | null): void;
  onPlace(dragged: TreeRef, target: TreeRef, zone: Zone): void; onStep(item: TreeRef, direction: 1 | -1): void;
}) {
  const [drop, setDrop] = useState<{ id: string; zone: Zone } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row; opener: HTMLElement | null } | null>(null);
  const [moving, setMoving] = useState(false);
  const dragging = useRef<TreeRef | null>(null);
  useEffect(() => { if (menu && !rows.some(row => row.id === menu.row.id && row.type === menu.row.type)) setMenu(null); }, [rows, menu]);
  const sortable = !searching;

  const zoneFor = (event: DragEvent, row: Row): Zone => {
    const box = event.currentTarget.getBoundingClientRect(), at = (event.clientY - box.top) / box.height;
    if (row.type === 'folder') return at < 0.28 ? 'before' : at > 0.72 ? 'after' : 'inside';
    return at < 0.5 ? 'before' : 'after';
  };
  const dragProps = (row: Row) => sortable ? {
    draggable: true,
    onDragStart: (event: DragEvent) => { dragging.current = { type: row.type, id: row.id }; event.dataTransfer.setData(dragType, `${row.type}:${row.id}`); event.dataTransfer.effectAllowed = 'move'; event.currentTarget.classList.add('dragging'); },
    onDragEnd: (event: DragEvent) => { dragging.current = null; setDrop(null); event.currentTarget.classList.remove('dragging'); },
    onDragOver: (event: DragEvent) => { if (!event.dataTransfer.types.includes(dragType)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const zone = zoneFor(event, row); setDrop(current => current?.id === row.id && current.zone === zone ? current : { id: row.id, zone }); },
    onDragLeave: () => setDrop(current => current?.id === row.id ? null : current),
    onDrop: (event: DragEvent) => { event.preventDefault(); const source = dragging.current; const zone = zoneFor(event, row); setDrop(null); dragging.current = null; if (source) onPlace(source, { type: row.type, id: row.id }, zone); },
  } : {};
  const onRowKey = (event: KeyboardEvent, row: Row) => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && sortable) { event.preventDefault(); onStep({ type: row.type, id: row.id }, event.key === 'ArrowUp' ? -1 : 1); return; }
    if (row.type === 'folder' && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) { event.preventDefault(); onExpand(row.item, event.key === 'ArrowRight'); return; }
    if (event.key === 'Enter') { event.preventDefault(); if (row.type === 'rule') onEdit(row.item); else onExpand(row.item, !row.open); return; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); const next = (event.key === 'ArrowUp' ? event.currentTarget.previousElementSibling : event.currentTarget.nextElementSibling) as HTMLElement | null; next?.focus(); }
  };
  const openMenu = (row: Row, x: number, y: number, opener: HTMLElement | null) => { setMoving(false); setMenu({ x, y, row, opener }); };
  const close = () => setMenu(null);
  const indent = (depth: number) => ({ paddingLeft: 8 + depth * 18 });
  const form = (depth: number, key: string) => <tr key={key} className="rule-folder-form-row"><td colSpan={7} style={indent(depth)}><form className="rule-folder-inline" onSubmit={event => { event.preventDefault(); onSaveFolder(); }}><Folder size={13} aria-hidden="true"/><input aria-label="Folder name" placeholder="Folder name" autoFocus maxLength={128} value={folderForm?.name ?? ''} onChange={event => folderForm && onFolderForm({ ...folderForm, name: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onFolderForm(null); } }}/><button type="button" onClick={() => onFolderForm(null)}>Cancel</button><button className="primary" type="submit" disabled={!folderForm?.name.trim()}>{folderForm?.id ? 'Save folder' : 'Create folder'}</button></form></td></tr>;
  const creatingIn = folderForm && !folderForm.id ? folderForm.parentId ?? null : undefined;

  return <div className="rule-table-wrap" onDragOver={sortable ? event => { if (event.target === event.currentTarget && event.dataTransfer.types.includes(dragType)) event.preventDefault(); } : undefined}>
    <table className="rule-table">
      <colgroup><col className="rule-colw-name"/><col className="rule-colw-method"/><col/><col className="rule-colw-stage"/><col className="rule-colw-stage"/><col className="rule-colw-stage"/><col className="rule-colw-actions"/></colgroup>
      <thead><tr><th>Name</th><th className="rule-col-method">Method</th><th>Matching rule</th>{stages.map(([, label]) => <th key={label} className="rule-col-stage">{label}</th>)}<th aria-label="Actions"/></tr></thead>
      <tbody>
        {creatingIn === null && form(0, 'new-root')}
        {rows.map(row => {
          const cls = `${row.type === 'folder' ? 'rule-folder-row' : 'rule-item-row'}${drop?.id === row.id ? ` drop-${drop.zone}` : ''}`;
          if (row.type === 'folder') {
            const folder = row.item, renaming = folderForm?.id === folder.id;
            return [renaming ? form(row.depth, `rename-${folder.id}`) : <tr key={`f:${folder.id}`} className={cls} tabIndex={0} aria-expanded={row.open} aria-level={row.depth + 1} {...dragProps(row)} onKeyDown={event => onRowKey(event, row)} onContextMenu={event => { event.preventDefault(); openMenu(row, event.clientX, event.clientY, event.currentTarget); }} onDoubleClick={event => { if (!(event.target as HTMLElement).closest('input,button')) onExpand(folder, !row.open); }}>
              <td style={indent(row.depth)}><span className="rule-name-cell"><button type="button" className={`rule-twisty${row.open ? ' open' : ''}`} aria-label={`${row.open ? 'Collapse' : 'Expand'} ${folder.name}`} onClick={() => onExpand(folder, !row.open)}><ChevronRight size={12}/></button>
                <input type="checkbox" aria-label={`Enable folder ${folder.name}`} title={row.state === 'mixed' ? 'Some rules in this folder are off' : undefined} checked={row.state === 'on'} ref={element => { if (element) element.indeterminate = row.state === 'mixed'; }} onChange={event => onToggleFolder(folder, event.target.checked)}/>
                {row.open ? <FolderOpen size={14} aria-hidden="true"/> : <Folder size={14} aria-hidden="true"/>}<strong title={folder.name}>{folder.name}</strong><small>{row.count}</small></span></td>
              <td className="rule-col-method"/><td/>{stages.map(([key]) => <td key={key} className="rule-col-stage"/>)}
              <td className="rule-actions"><button type="button" className="icon-button" aria-label={`Add rule to ${folder.name}`} title="Add rule to this folder" onClick={() => onAddRule(folder.id)}><Plus/></button><button type="button" className="icon-button" aria-label={`Folder actions for ${folder.name}`} title="Folder actions" aria-haspopup="menu" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); openMenu(row, box.left - 190, box.bottom + 2, event.currentTarget); }}><MoreHorizontal/></button></td>
            </tr>, creatingIn === folder.id && form(row.depth + 1, `new-${folder.id}`)];
          }
          const rule = row.item, name = ruleLabel(rule), method = rule.method || '*';
          return <tr key={`r:${rule.id}`} className={cls} tabIndex={0} aria-level={row.depth + 1} {...dragProps(row)} onKeyDown={event => onRowKey(event, row)} onClick={event => { if (!(event.target as HTMLElement).closest('input,button')) onEdit(rule); }} onContextMenu={event => { event.preventDefault(); openMenu(row, event.clientX, event.clientY, event.currentTarget); }}>
            <td style={indent(row.depth)}><span className="rule-name-cell"><span className="rule-twisty-space" aria-hidden="true"/><input type="checkbox" aria-label={`Enable ${name.label}`} checked={rule.enabled} onChange={event => onToggleRule(rule, event.target.checked)}/>
              <button type="button" className={`rule-name${name.custom ? '' : ' fallback'}`} aria-label={`Edit ${name.label}`} title={name.text} onClick={() => onEdit(rule)}>{name.text}</button></span></td>
            <td className="rule-col-method"><span className="rule-method">{method === '*' ? 'ANY' : method}</span></td>
            <td><code title={rule.pattern}>{rule.pattern}</code></td>
            {stages.map(([key, label]) => <td key={key} className="rule-col-stage">{rule.stages.includes(key) ? <span className="rule-stage on" role="img" aria-label={label} title={key === 'event' ? 'Each SSE event' : label}/> : <span className="rule-stage" aria-hidden="true"/>}</td>)}
            <td className="rule-actions"><button type="button" className="icon-button" aria-label={`Rule actions for ${name.label}`} title="Rule actions" aria-haspopup="menu" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); openMenu(row, box.left - 190, box.bottom + 2, event.currentTarget); }}><MoreHorizontal/></button><button type="button" className="icon-button rule-delete" aria-label={`Delete ${name.label}`} title="Delete rule" onClick={() => onDeleteRule(rule)}><Trash2/></button></td>
          </tr>;
        })}
      </tbody>
    </table>
    {!rows.length && creatingIn === undefined && <div className="rule-empty"><ListFilter aria-hidden="true"/><p>{emptyMessage}</p></div>}
    {menu && <PopupMenu x={menu.x} y={menu.y} label={`Actions for ${menu.row.type === 'folder' ? menu.row.item.name : ruleLabel(menu.row.item).label}`} opener={menu.opener} onClose={close}>
      {menu.row.type === 'folder' ? <>
        <button role="menuitem" onClick={() => { onAddRule(menu.row.id); close(); }}><Plus size={13}/>Add rule here</button>
        <button role="menuitem" onClick={() => { if (menu.row.type === 'folder' && !menu.row.open) onExpand(menu.row.item, true); onFolderForm({ parentId: menu.row.id, name: '' }); close(); }}><FolderPlus size={13}/>New folder inside…</button>
        <button role="menuitem" onClick={() => { onFolderForm({ id: menu.row.id, name: (menu.row.item as TableFolder).name }); close(); }}><Pencil size={13}/>Rename…</button>
      </> : <button role="menuitem" onClick={() => { onEdit(menu.row.item as TableRule); close(); }}><Pencil size={13}/>Edit…</button>}
      <button role="menuitem" aria-haspopup="menu" aria-expanded={moving} onClick={() => setMoving(!moving)}><Folder size={13}/>Move to<span aria-hidden="true">{moving ? '▾' : '▸'}</span></button>
      {moving && <div className="rule-menu-sub" role="group" aria-label="Destinations">
        <button role="menuitemradio" aria-checked={menu.row.parentId === null} onClick={() => { onPlace({ type: menu.row.type, id: menu.row.id }, { type: 'folder', id: '' }, 'inside'); close(); }}><span>Top level</span>{menu.row.parentId === null && <span aria-hidden="true">✓</span>}</button>
        {folders.filter(folder => !(menu.row.type === 'folder' && folder.id === menu.row.id)).map(folder => <button key={folder.id} role="menuitemradio" aria-checked={menu.row.parentId === folder.id} onClick={() => { onPlace({ type: menu.row.type, id: menu.row.id }, { type: 'folder', id: folder.id }, 'inside'); close(); }}><span title={folderPath(folders, folder.id)}>{folderPath(folders, folder.id)}</span>{menu.row.parentId === folder.id && <span aria-hidden="true">✓</span>}</button>)}
      </div>}
      {sortable && <><button role="menuitem" onClick={() => { onStep({ type: menu.row.type, id: menu.row.id }, -1); close(); }}>Move up<span aria-hidden="true">⌥↑</span></button><button role="menuitem" onClick={() => { onStep({ type: menu.row.type, id: menu.row.id }, 1); close(); }}>Move down<span aria-hidden="true">⌥↓</span></button></>}
      {menu.row.type === 'folder' ? <button role="menuitem" className="error-text" onClick={() => { onDeleteFolder(menu.row.item as TableFolder); close(); }}><Trash2 size={13}/>Delete folder…</button> : <button role="menuitem" className="error-text" onClick={() => { onDeleteRule(menu.row.item as TableRule); close(); }}><Trash2 size={13}/>Delete rule</button>}
    </PopupMenu>}
  </div>;
}
