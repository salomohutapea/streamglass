import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import './capture-picker.css';

export type PickerRecord = { id: string; method: string; url: string; status?: number; statusCode?: number; kind?: string; isSSE?: boolean; device?: string };
type Props = {
  records: PickerRecord[];
  /** Selected ids. Single mode uses at most one. */
  value: string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
  /** Capture currently selected in the main window; shows a "Use selected" shortcut. */
  mainSelectionId?: string;
  label?: string;
  /** Max rows rendered at once; the search narrows the rest. */
  limit?: number;
  maxSelected?: number;
};
const statusOf = (r: PickerRecord) => r.status ?? r.statusCode;
const tone = (status?: number) => !status ? 'pending' : status >= 500 ? 'error' : status >= 400 ? 'warn' : 'ok';

/** Searchable capture list shared by the testing tools (Replay, Compare, Mock, Share, ...). */
export default function CapturePicker({ records, value, onChange, multiple = false, mainSelectionId, label = 'Captures', limit = 200, maxSelected }: Props) {
  const [query, setQuery] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const candidates = useMemo(() => records.filter(r => r.kind !== 'tunnel'), [records]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates.filter(r => (!q || `${r.method} ${r.url} ${statusOf(r) ?? ''}`.toLowerCase().includes(q)) && (!errorsOnly || (statusOf(r) ?? 0) >= 400));
  }, [candidates, query, errorsOnly]);
  const shown = filtered.slice(0, limit);
  const toggle = (id: string) => {
    if (!multiple) return onChange([id]);
    if (value.includes(id)) return onChange(value.filter(v => v !== id));
    onChange(maxSelected && value.length >= maxSelected ? [...value.slice(1), id] : [...value, id]);
  };
  return <section className="capture-picker" aria-label={label}>
    <div className="capture-picker-bar">
      <label className="capture-picker-search"><Search size={13} /><input type="search" aria-label={`Search ${label.toLowerCase()}`} placeholder="Search method, URL or status" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label className="capture-picker-check"><input type="checkbox" checked={errorsOnly} onChange={e => setErrorsOnly(e.target.checked)} />Errors only</label>
      {mainSelectionId && candidates.some(r => r.id === mainSelectionId) && <button type="button" disabled={!multiple && value[0] === mainSelectionId} onClick={() => onChange(multiple ? [...new Set([...value, mainSelectionId])] : [mainSelectionId])}>Use selected in main window</button>}
      {multiple && value.length > 0 && <button type="button" onClick={() => onChange([])}>Clear ({value.length})</button>}
    </div>
    <ul className="capture-picker-list" role="listbox" aria-multiselectable={multiple} aria-label={label}>
      {shown.map(r => {
        const status = statusOf(r), selected = value.includes(r.id);
        return <li key={r.id} role="option" aria-selected={selected}>
          <button type="button" className={selected ? 'selected' : ''} onClick={() => toggle(r.id)}>
            {multiple && <input type="checkbox" tabIndex={-1} readOnly checked={selected} aria-hidden="true" />}
            <span className="capture-picker-method" data-method={r.method}>{r.method}</span>
            <span className="capture-picker-url" title={r.url}>{r.url}</span>
            <span className={`capture-picker-status ${tone(status)}`}>{status ?? '…'}</span>
          </button>
        </li>;
      })}
      {shown.length === 0 && <li className="capture-picker-empty">{candidates.length ? 'No captures match.' : 'No captures yet.'}</li>}
    </ul>
    {filtered.length > shown.length && <p className="capture-picker-more">Showing {shown.length} of {filtered.length}. Search to narrow.</p>}
  </section>;
}
