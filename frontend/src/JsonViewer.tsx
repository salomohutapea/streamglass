import { useEffect, useMemo, useState } from 'react';
import { foldJson, jsonContainers, jsonHighlights, jsonPage, prepareJson } from './json-viewer.mjs';
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
  const [copied, setCopied] = useState<number | null>(null);
  const copyContainer = (range: JsonContainer) => {
    const text = document.text.slice(range.start, range.end);
    Promise.resolve(window.streamglass?.copyText ? window.streamglass.copyText(text) : navigator.clipboard.writeText(text)).then(() => { setCopied(range.start); setTimeout(() => setCopied(current => current === range.start ? null : current), 1200); }).catch(() => {});
  };
  useEffect(() => { setStarts([0]); setCollapsed(new Set()); }, [document]);
  const folded = useMemo(() => foldJson(document.text, containers, collapsed), [document, containers, collapsed]);
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
  const lines = page.text.split('\n');
  if (page.text.endsWith('\n')) lines.pop();
  const paginated = page.hasNext || starts.length > 1;
  let position = page.start;
  return <section className="json-viewer" aria-label={document.isJson ? 'JSON body' : 'Body'}>
    {containers.length > 0 && <div className="json-toolbar"><button type="button" onClick={() => { setCollapsed(new Set()); setStarts([0]); }}>Expand all</button><button type="button" onClick={() => { setCollapsed(new Set(containers.map(range => range.start))); setStarts([0]); }}>Collapse all</button><span>{onReplace ? 'Use Copy or Replace beside an object or array.' : 'Use Copy beside an object or array.'}</span></div>}
    <div className="json-viewer-content">
      {document.isJson && <pre className="json-line-numbers" aria-hidden="true">{lines.map((_, i) => firstLine + i).join('\n')}</pre>}
      <pre className="json-code"><code>{tokens.map((token, i) => {
        const range = visible.get(position);
        position += token.text.length;
        return <span key={i}>{range && <><button type="button" className="json-fold" aria-label={`${collapsed.has(range.start) ? 'Expand' : 'Collapse'} ${range.kind} at offset ${range.start}`} aria-expanded={!collapsed.has(range.start)} onClick={() => { setCollapsed(previous => { const next = new Set(previous); if (next.has(range.start)) next.delete(range.start); else next.add(range.start); return next; }); setStarts([0]); }}>{collapsed.has(range.start) ? '▸' : '▾'}</button><button type="button" className="json-copy" aria-label={`Copy ${range.kind} at offset ${range.start}`} onClick={() => copyContainer(range)}>{copied === range.start ? 'Copied' : 'Copy'}</button>{onReplace && <button type="button" className="json-replace" disabled={disabled} aria-label={`Replace ${range.kind} at offset ${range.start}`} onClick={() => onReplace(range)}>Replace</button>}</>}{token.kind ? <span className={`json-${token.kind}`}>{token.text}</span> : token.text}</span>;
      })}</code></pre>
    </div>
    {paginated && <nav className="json-pagination" aria-label="Body pages">
      <button type="button" disabled={starts.length === 1} onClick={() => setStarts(previous => previous.slice(0, -1))}>Previous</button>
      <span>Page {starts.length}{page.hasNext ? ' · more content' : ' · end'}</span>
      <button type="button" disabled={!page.hasNext} onClick={() => setStarts(previous => [...previous, page.end])}>Next</button>
    </nav>}
  </section>;
}
