import type { RefObject } from 'react';
import { Loader2, Plus, Search, X } from 'lucide-react';

export type SearchScope = 'url' | 'request' | 'response' | 'event';
export const scopeLabels: Record<SearchScope, string> = { url: 'URL', request: 'Request', response: 'Response', event: 'SSE events' };
const placeholders: Record<SearchScope, string> = {
  url: 'Filter by URL…', request: 'Search request headers and bodies…', response: 'Search response headers and bodies…', event: 'Search SSE event data…',
};
export const modes: [string, string][] = [['contains', 'Contains'], ['not_contains', 'Does not contain'], ['equals', 'Equals'], ['starts_with', 'Starts with'], ['ends_with', 'Ends with'], ['wildcard', 'Wildcard']];

type Props = {
  inputRef: RefObject<HTMLInputElement | null>;
  scope: SearchScope; mode: string; query: string; searching: boolean; active: boolean; canAddCondition: boolean;
  onScope: (scope: SearchScope) => void; onMode: (mode: string) => void; onQuery: (query: string) => void;
  onAddCondition: () => void; onClose: () => void;
};

// Opened with ⌘F. The scope select is styled as the bar's label so it is always clear what is being searched.
export default function FilterBar(p: Props) {
  return <div className={`filter-bar${p.active ? ' active' : ''}`} role="search" aria-label="Filter requests">
    <select className="filter-scope" aria-label="Search content" value={p.scope} onChange={event => p.onScope(event.target.value as SearchScope)}>
      {(Object.keys(scopeLabels) as SearchScope[]).map(value => <option key={value} value={value}>{scopeLabels[value]}</option>)}
    </select>
    <select aria-label="Match mode" value={p.mode} onChange={event => p.onMode(event.target.value)}>
      {modes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
    <label className="filter-input">
      {p.searching ? <Loader2 className="spin" size={13} role="status" aria-label="Searching" /> : <Search size={13} />}
      <input ref={p.inputRef} aria-label="Filter requests" placeholder={placeholders[p.scope]} maxLength={1024} value={p.query} onChange={event => p.onQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); if (p.query) p.onQuery(''); else p.onClose(); } }} />
      {p.query && <button type="button" className="icon-button" aria-label="Clear filter text" title="Clear" onClick={() => { p.onQuery(''); p.inputRef.current?.focus(); }}><X size={12} /></button>}
    </label>
    <button type="button" className="icon-button" aria-label="Add filter condition" title="Add a condition" disabled={!p.canAddCondition} onClick={p.onAddCondition}><Plus size={14} /></button>
    <button type="button" className="icon-button" aria-label="Close filter" title="Clear and close (Esc)" onClick={p.onClose}><X size={14} /></button>
  </div>;
}
