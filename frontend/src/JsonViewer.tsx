import { useEffect, useMemo, useRef, useState } from 'react';
import { findMatches, foldJson, jsonContainers, jsonHighlights, jsonPage, pageStartsFor, prepareJson, splitByMatches } from './json-viewer.mjs';
import type { JsonContainer } from './json-viewer.mjs';
import './json-viewer.css';

type Props = { value: unknown; unavailable?: boolean; preserveFormatting?: boolean; onReplace?: (range: JsonContainer) => void; disabled?: boolean };
export default function JsonViewer({ value, unavailable = false, preserveFormatting = false, onReplace, disabled = false }: Props) {
  const document = useMemo(() => {
    if (unavailable) return { text: 'Body streamed to the client and not retained.', isJson: false };
    const prepared = prepareJson(value);
    return preserveFormatting && typeof value === 'string' ? { ...prepared, text: value } : prepared;
  }, [value, unavailable, preserveFormatting]);
  const containers = useMemo(() => document.isJson ? jsonContainers(document.text) : [], [document]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [starts, setStarts] = useState([0]);
  const [copied, setCopied] = useState<{ start: number; ok: boolean } | null>(null);
  const copyContainer = async (range: JsonContainer) => {
    const text = document.text.slice(range.start, range.end);
    let ok = true;
    try {
      if (window.streamglass?.copyText) await window.streamglass.copyText(text);
      else await navigator.clipboard.writeText(text);
    } catch {
      try { await navigator.clipboard.writeText(text); } catch { ok = false; }
    }
    setCopied({ start: range.start, ok });
    setTimeout(() => setCopied(current => current?.start === range.start ? null : current), ok ? 1500 : 3500);
  };
  useEffect(() => { setStarts([0]); setCollapsed(new Set()); }, [document]);
  const folded = useMemo(() => foldJson(document.text, containers, collapsed), [document, containers, collapsed]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => findMatches(folded.text, query), [folded.text, query]);
  useEffect(() => { setQuery(''); setActive(0); }, [document]);
  useEffect(() => { if (query) setCollapsed(previous => previous.size ? new Set() : previous); setActive(0); }, [query]);
  const activeMatch = matches[Math.min(active, matches.length - 1)];
  useEffect(() => {
    if (!activeMatch) return;
    const target = pageStartsFor(folded.text, activeMatch.start);
    setStarts(previous => previous[previous.length - 1] === target[target.length - 1] ? previous : target);
  }, [activeMatch, folded.text]);
  const start = Math.min(starts[starts.length - 1], folded.text.length);
  const page = useMemo(() => jsonPage(folded.text, start), [folded, start]);
  const tokens = useMemo(() => document.isJson
    ? jsonHighlights(folded.text, page.start, page.end)
    : [{ text: page.text, kind: '' }], [document.isJson, folded, page]);
  const visible = useMemo(() => new Map(folded.ranges.filter(range => range.displayStart >= page.start && range.displayStart < page.end).map(range => [range.displayStart, range])), [folded, page]);
  const firstLine = useMemo(() => {
    let line = 1;
    for (let i = 0; i < start; i++) if (folded.text[i] === '\n') line++;
    return line;
  }, [folded, start]);
  useEffect(() => { if (activeMatch) contentRef.current?.querySelector('.json-match.active')?.scrollIntoView({ block: 'center', inline: 'nearest' }); }, [activeMatch, page.start]);
  const step = (direction: number) => { if (matches.length) setActive(current => (Math.min(current, matches.length - 1) + direction + matches.length) % matches.length); };
  const lines = page.text.split('\n');
  if (page.text.endsWith('\n')) lines.pop();
  const paginated = page.hasNext || starts.length > 1;
  let position = page.start;
  return <section className="json-viewer" aria-label={document.isJson ? 'JSON body' : 'Body'}>
    {!unavailable && document.text.length > 0 && <div className="json-toolbar">
      <input type="search" className="json-search" aria-label="Search in body" placeholder="Search in body" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); } else if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); } }}/>
      {query && <><span className="json-search-count" role="status">{matches.length ? `${Math.min(active, matches.length - 1) + 1} of ${matches.length}${matches.length >= 5000 ? '+' : ''}` : 'No matches'}</span><button type="button" aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)}>↑</button><button type="button" aria-label="Next match" disabled={!matches.length} onClick={() => step(1)}>↓</button></>}
      {containers.length > 0 && <><button type="button" onClick={() => { setCollapsed(new Set()); setStarts([0]); }}>Expand all</button><button type="button" onClick={() => { setCollapsed(new Set(containers.map(range => range.start))); setStarts([0]); }}>Collapse all</button></>}
    </div>}
    <div className="json-viewer-content" ref={contentRef}><div className="json-rows">
      {document.isJson && <pre className="json-line-numbers" aria-hidden="true">{lines.map((_, i) => firstLine + i).join('\n')}</pre>}
      <pre className="json-code"><code>{tokens.map((token, i) => {
        const range = visible.get(position);
        const tokenStart = position;
        position += token.text.length;
        const content = matches.length ? splitByMatches(token.text, tokenStart, matches, Math.min(active, matches.length - 1)).map((part, index) => part.match ? <mark key={index} className={part.match === 'active' ? 'json-match active' : 'json-match'}>{part.text}</mark> : part.text) : token.text;
        return <span key={i}>{range && <><button type="button" className="json-fold" aria-label={`${collapsed.has(range.start) ? 'Expand' : 'Collapse'} ${range.kind} at offset ${range.start}`} aria-expanded={!collapsed.has(range.start)} onClick={() => { setCollapsed(previous => { const next = new Set(previous); if (next.has(range.start)) next.delete(range.start); else next.add(range.start); return next; }); setStarts([0]); }}>{collapsed.has(range.start) ? '▸' : '▾'}</button><button type="button" className="json-copy" aria-label={`Copy ${range.kind} at offset ${range.start}`} onClick={() => copyContainer(range)}>{copied?.start === range.start ? copied.ok ? 'Copied' : 'Copy failed' : 'Copy'}</button>{onReplace && <button type="button" className="json-replace" disabled={disabled} aria-label={`Replace ${range.kind} at offset ${range.start}`} onClick={() => onReplace(range)}>Replace</button>}</>}{token.kind ? <span className={`json-${token.kind}`}>{content}</span> : content}</span>;
      })}</code></pre>
    </div></div>
    {paginated && <nav className="json-pagination" aria-label="Body pages">
      <button type="button" disabled={starts.length === 1} onClick={() => setStarts(previous => previous.slice(0, -1))}>Previous</button>
      <span>Page {starts.length}{page.hasNext ? ' · more content' : ' · end'}</span>
      <button type="button" disabled={!page.hasNext} onClick={() => setStarts(previous => [...previous, page.end])}>Next</button>
    </nav>}
  </section>;
}
