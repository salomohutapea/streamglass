import { memo, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ChevronRight, Copy, Crosshair, Eye, EyeOff, Globe, Lock, MoreVertical, Search } from 'lucide-react';
import { buildDomainTree, filterHostNodes, type DomainFilter, type DomainNode } from './domain-tree.mjs';
import './domain-tree.css';

type Props = {
  records: { url?: string; host?: string; kind?: string; isEncrypted?: boolean }[];
  hidden: Set<string>;
  active: DomainFilter | null;
  collapsed: boolean;
  busy: boolean;
  isInspected: (host: string) => boolean;
  onToggleSection: () => void;
  onSelect: (filter: DomainFilter) => void;
  onHide: (host: string) => void;
  onRestore: (host: string | null) => void;
  onInspect: (host: string) => void;
  onCopy: (host: string) => void;
};

const SEARCH_THRESHOLD = 8;

function DomainTreeView(props: Props) {
  const { records, hidden, active, collapsed, busy, isInspected } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ host: string; x: number; y: number } | null>(null);
  const tree = useMemo(() => buildDomainTree(records, { hidden }), [records, hidden]);
  const visible = useMemo(() => (tree.length > SEARCH_THRESHOLD ? filterHostNodes(tree, query) : tree), [tree, query]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', key); };
  }, [menu]);

  const toggle = (id: string) => setExpanded(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const isActive = (node: DomainNode) => active?.host === node.host && (active?.path ?? '') === (node.path ?? '');
  const open = (event: MouseEvent, host: string) => { event.preventDefault(); setMenu({ host, x: Math.min(event.clientX, window.innerWidth - 200), y: Math.min(event.clientY, window.innerHeight - 150) }); };

  const renderNode = (node: DomainNode, level: number) => {
    const id = node.host + (node.path ?? '');
    const isHost = node.path === undefined;
    const canExpand = node.children.length > 0;
    const isOpen = expanded.has(id);
    const inspected = isHost && isInspected(node.host);
    return <div key={id} role="none">
      <div className={`domain-row ${isActive(node) ? 'selected' : ''}`} role="treeitem" aria-level={level + 1} aria-expanded={canExpand ? isOpen : undefined} aria-selected={isActive(node)} style={{ paddingLeft: 4 + level * 12 }} onContextMenu={isHost ? event => open(event, node.host) : undefined}>
        <button type="button" className="domain-twisty" tabIndex={canExpand ? 0 : -1} aria-label={canExpand ? `${isOpen ? 'Collapse' : 'Expand'} ${node.label}` : undefined} disabled={!canExpand} onClick={() => toggle(id)}><ChevronRight className={isOpen ? 'open' : ''} aria-hidden="true" /></button>
        <button type="button" className="domain-label" title={`${node.host}${node.path ?? ''} · ${node.count} request${node.count === 1 ? '' : 's'}`} onClick={() => props.onSelect({ host: node.host, path: node.path })}>
          <span className="domain-name">{node.label}</span>
          {isHost && (inspected ? <Lock className="domain-lock on" size={11} aria-label="SSL inspection on" /> : !!node.encrypted && <Lock className="domain-lock" size={11} aria-label="Encrypted tunnel" />)}
          <span className="domain-count">{node.count}</span>
        </button>
        {isHost && <span className="domain-actions"><button type="button" aria-label={`Actions for ${node.host}`} aria-haspopup="menu" title="More actions" onPointerDown={event => event.stopPropagation()} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu(current => current?.host === node.host ? null : { host: node.host, x: Math.min(box.left, window.innerWidth - 200), y: Math.min(box.bottom + 4, window.innerHeight - 150) }); }}><MoreVertical size={13} /></button></span>}
      </div>
      {canExpand && isOpen && <div role="group">{node.children.map(child => renderNode(child, level + 1))}{node.more > 0 && <p className="domain-more" style={{ paddingLeft: 20 + (level + 1) * 12 }}>+{node.more} more paths</p>}</div>}
    </div>;
  };

  const hiddenList = [...hidden].sort();
  return <>
    <div className="sidebar-heading device-heading"><button className="sidebar-section-toggle" aria-expanded={!collapsed} aria-controls="sidebar-domains" onClick={props.onToggleSection}><ChevronRight aria-hidden="true" />Domains</button></div>
    <button type="button" className="nav-row domain-rail-button" aria-label="Domains" title="Domains" onClick={props.onToggleSection}><Globe /></button>
    <div id="sidebar-domains" className="domain-tree" hidden={collapsed}>
      {tree.length > SEARCH_THRESHOLD && <label className="domain-search"><Search size={12} /><input aria-label="Search domains" placeholder="Search domains" value={query} onChange={event => setQuery(event.target.value)} /></label>}
      <div role="tree" aria-label="Captured domains">{visible.map(node => renderNode(node, 0))}</div>
      {!tree.length && <p className="sidebar-note">{hidden.size ? 'All domains are hidden.' : 'Hosts appear when they send traffic.'}</p>}
      {!!tree.length && !visible.length && <p className="sidebar-note">No matching domains.</p>}
      {!!hiddenList.length && <div className="domain-hidden">
        <div className="domain-hidden-title"><span>Hidden domains · {hiddenList.length}</span><button type="button" onClick={() => props.onRestore(null)}>Restore all</button></div>
        {hiddenList.map(host => <div className="domain-hidden-row" key={host}><span title={host}>{host}</span><button type="button" aria-label={`Restore ${host}`} title="Restore" onClick={() => props.onRestore(host)}><Eye size={12} /></button></div>)}
      </div>}
    </div>
    {menu && <div className="domain-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={event => event.stopPropagation()}>
      <button role="menuitem" onClick={() => { props.onSelect({ host: menu.host }); setMenu(null); }}><Crosshair size={13} />Focus</button>
      <button role="menuitem" onClick={() => { props.onHide(menu.host); setMenu(null); }}><EyeOff size={13} />Hide</button>
      <button role="menuitem" disabled={busy || isInspected(menu.host)} onClick={() => { props.onInspect(menu.host); setMenu(null); }}><Lock size={13} />{isInspected(menu.host) ? 'SSL inspection on' : 'Enable SSL inspection'}</button>
      <button role="menuitem" onClick={() => { props.onCopy(menu.host); setMenu(null); }}><Copy size={13} />Copy host</button>
    </div>}
  </>;
}

export const DomainTree = memo(DomainTreeView);
