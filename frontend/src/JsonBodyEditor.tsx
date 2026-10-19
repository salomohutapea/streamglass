import { useEffect, useMemo, useRef, useState } from 'react';
import JsonViewer from './JsonViewer';
import { prepareJson, replaceJsonContainer } from './json-viewer.mjs';
import type { JsonContainer } from './json-viewer.mjs';

type Props = { value: string; label: string; disabled?: boolean; onChange: (value: string) => void; onReplacingChange: (editing: boolean) => void };
export default function JsonBodyEditor({ value, label, disabled = false, onChange, onReplacingChange }: Props) {
  const isJson = useMemo(() => prepareJson(value).isJson, [value]);
  const [raw, setRaw] = useState(false);
  const [replacement, setReplacement] = useState<{ range: JsonContainer; text: string } | null>(null);
  const [error, setError] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (replacement) { textarea.current?.focus(); textarea.current?.select(); } }, [Boolean(replacement)]);
  useEffect(() => () => onReplacingChange(false), [onReplacingChange]);
  const close = () => { setReplacement(null); setError(''); onReplacingChange(false); };
  return <div className="json-body-editor">
    {isJson && !replacement && <div className="json-editor-mode"><button type="button" disabled={disabled} onClick={() => setRaw(previous => !previous)}>{raw ? 'Foldable JSON' : 'Edit entire body'}</button><span>{raw ? 'Changes edit the entire body.' : 'Collapse an object, then use Replace to edit it in place.'}</span></div>}
    {replacement ? <div className="json-subtree-editor" role="group" aria-label={`Replace ${replacement.range.kind}`}>
      <p>Replace this {replacement.range.kind}. Only this value will change.</p>
      <textarea ref={textarea} className="mono editor-body" aria-label={`Replacement ${replacement.range.kind}`} spellCheck={false} value={replacement.text} disabled={disabled} onChange={event => setReplacement({ ...replacement, text: event.target.value })} onKeyDown={event => { if (event.metaKey && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); } }}/>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="json-subtree-actions"><span>Apply or cancel before continuing traffic.</span><button type="button" onClick={close}>Cancel replacement</button><button type="button" className="primary" disabled={disabled} onClick={() => { try { onChange(replaceJsonContainer(value, replacement.range, replacement.text)); close(); } catch { setError('Replacement must be valid JSON.'); } }}>Apply replacement</button></div>
    </div> : isJson && !raw ? <JsonViewer value={value} preserveFormatting disabled={disabled} onReplace={range => { setReplacement({ range, text: value.slice(range.start, range.end) }); setError(''); onReplacingChange(true); }}/> : <textarea className="mono editor-body" aria-label={label} spellCheck={false} disabled={disabled} value={value} onChange={event => onChange(event.target.value)}/>}
  </div>;
}
