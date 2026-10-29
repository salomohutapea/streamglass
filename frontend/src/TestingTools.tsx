import { useEffect, useMemo, useState } from 'react';
import JsonViewer from './JsonViewer';
import CapturePicker, { EmptyState } from './CapturePicker';
import { encodeReplayText, decodeReplayText, replayHeaders } from './replay-body.mjs';
import { formatJson, redactCapture } from './capture-tools.mjs';
import { useCaptureComparison } from './capture-compare';
import { Loader2, TriangleAlert, MousePointerClick, ArrowRightLeft } from 'lucide-react';
import CaptureDiff from './CaptureDiff';
import { requestTime } from './TrafficTable';

type Api = (path: string, method?: string, body?: any) => Promise<any>;
type Props = { api: Api; connection?: { baseUrl: string; token: string } | null; records: any[]; selectedId?: string; tab: string; active: boolean; onChanged: () => Promise<void>; onSelect: (id: string) => void; onOpenTab: (tab: string) => void };
export const testingTabs = ['Compare', 'Replay', 'Create mock', 'Share'];
const MAX_REPLAY = 20;
const defaultRedactFields = ['authorization', 'cookie', 'set-cookie', 'password', 'token', 'access_token', 'refresh_token', 'secret', 'api_key'];
type ReplayResult = { key: string; sourceId: string; label: string; status?: number; durationMs?: number | null; response?: any; error?: string; resultId?: string };

const statusOf = (c: any) => c?.response?.statusCode ?? c?.statusCode ?? c?.status;
const durationOf = (c: any) => c?.durationMs ?? c?.duration ?? null;

// `compact` skips the raw wire copies of SSE events, which comparisons don't read.
function useCapture(api: Api, id: string, onError: (message: string) => void, compact = false) {
  const [capture, setCapture] = useState<any>(null);
  useEffect(() => {
    let live = true;
    setCapture(null);
    if (id) api(`/api/records/${encodeURIComponent(id)}${compact ? '?compact=1' : ''}`).then(value => { if (live) setCapture(value); }).catch(e => { if (live) onError(e.message ?? String(e)); });
    return () => { live = false; };
  }, [id]);
  return capture;
}

function ResponseSummary({ capture, title }: { capture: any; title: string }) {
  const response = capture?.response;
  return <section className="testing-response" aria-label={title}>
    <h4>{title}</h4>
    {response ? <>
      <p className="muted">Status {response.statusCode ?? statusOf(capture) ?? 'none'} · {response.headers?.length ?? 0} headers{durationOf(capture) != null ? ` · ${Math.round(durationOf(capture))} ms` : ''}</p>
      <JsonViewer value={response.body ?? ''} unavailable={!!response.bodyUnavailable} />
    </> : <EmptyState>No response</EmptyState>}
  </section>;
}

export default function TestingTools({ api, connection, records, selectedId, tab, active, onChanged, onSelect, onOpenTab }: Props) {
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function act(operation: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await operation(); } catch (e: any) { setError(e.message ?? String(e)); } finally { setBusy(false); } }
  useEffect(() => { setError(''); setNotice(''); }, [tab]);
  const initial = selectedId && records.some(r => r.id === selectedId) ? selectedId : '';

  // Replay
  const [replayIds, setReplayIds] = useState<string[]>(initial ? [initial] : []);
  const [bodyMode, setBodyMode] = useState<'text' | 'base64'>('text'), [bodyText, setBodyText] = useState(''), [bodyReplaced, setBodyReplaced] = useState(false);
  const [replay, setReplay] = useState({ url: '', method: 'GET', headers: '[]', bodyBase64: ''});
  const [results, setResults] = useState<ReplayResult[]>([]);
  const single = replayIds.length === 1 ? replayIds[0] : '';
  const original = useCapture(api, single, setError);
  useEffect(() => {
    setResults([]);
    if (!original) return;
    setBodyReplaced(false); setBodyMode('text'); setBodyText(original.request?.body ?? '');
    setReplay({ url: original.request?.url ?? original.url, method: original.request?.method ?? original.method, headers: JSON.stringify(original.request?.headers ?? [], null, 2), bodyBase64: original.request?.bodyBase64 ?? '' });
  }, [original]);
  const ready = !!original && original.id === single;
  const recordLabel = (id: string) => { const r = records.find(x => x.id === id); return r ? `${r.method} ${r.url}` : id; };

  async function replayRecord(id: string, form?: { url: string; method: string; headers: any; bodyBase64: string }): Promise<ReplayResult> {
    const label = recordLabel(id);
    try {
      let payload = form;
      if (!payload) {
        const source = await api(`/api/records/${encodeURIComponent(id)}`);
        if (source.isEncrypted) throw new Error('Encrypted tunnels cannot be replayed.');
        if (source.request?.bodyUnavailable) throw new Error('The original request body was not retained.');
        payload = { url: source.request?.url ?? source.url, method: source.request?.method ?? source.method, headers: replayHeaders(source.request?.headers ?? [], false), bodyBase64: source.request?.bodyBase64 ?? '' };
      }
      const started = performance.now();
      const sent = await api('/api/replay', 'POST', payload);
      let response: any = null;
      try { response = await api(`/api/records/${encodeURIComponent(sent.id)}`); } catch { /* result row still reports the capture id */ }
      return { key: `${id}-${sent.id}`, sourceId: id, label, resultId: sent.id, response, status: statusOf(response), durationMs: durationOf(response) ?? Math.round(performance.now() - started) };
    } catch (e: any) { return { key: `${id}-${Date.now()}-${Math.random()}`, sourceId: id, label, error: e.message ?? String(e) }; }
  }

  // Compare
  const [slotA, setSlotA] = useState(initial), [slotB, setSlotB] = useState(''), [picking, setPicking] = useState<'A' | 'B' | null>(null);
  const [section, setSection] = useState<'request' | 'response' | 'events'>('response'), [ignore, setIgnore] = useState(''), [eventKey, setEventKey] = useState<'sequence' | 'id'>('sequence');
  // With an engine connection the comparison worker fetches and parses both captures itself, so even 30 MiB SSE
  // captures never block this window; otherwise the captures load here first.
  const captureA = useCapture(api, connection ? '' : slotA, setError, true), captureB = useCapture(api, connection ? '' : slotB, setError, true);
  const sourceOf = (id: string, capture: any) => connection ? (id ? { fetchUrl: `${connection.baseUrl}/api/records/${encodeURIComponent(id)}?compact=1`, authorization: `Bearer ${connection.token}` } : null) : capture;
  // Either side can instead be custom JSON, typed, pasted or read from the clipboard.
  const [modes, setModes] = useState<{ A: 'capture' | 'json'; B: 'capture' | 'json' }>({ A: 'capture', B: 'capture' }), [customJson, setCustomJson] = useState({ A: '', B: '' });
  const custom = (name: 'A' | 'B') => modes[name] === 'json' ? (customJson[name].trim() ? { custom: customJson[name] } : null) : undefined;
  const sourceA = useMemo(() => custom('A') ?? sourceOf(slotA, captureA), [connection, slotA, captureA, modes.A, customJson.A]), sourceB = useMemo(() => custom('B') ?? sourceOf(slotB, captureB), [connection, slotB, captureB, modes.B, customJson.B]);
  const [focusPath, setFocusPath] = useState('');
  // Custom JSON or a chosen path compares bodies only; a path also narrows them, e.g. to the response's `data` field.
  const bodyOnly = modes.A === 'json' || modes.B === 'json' || Boolean(focusPath.trim());
  const comparison = useCaptureComparison(sourceA, sourceB, { section, ignoreFields: ignore.split(',').map(s => s.trim()).filter(Boolean), eventKey, bodyOnly, focusPath: focusPath.trim() });
  async function pasteClipboard(name: 'A' | 'B') {
    try { const text = window.streamglass?.readClipboardText ? await window.streamglass.readClipboardText() : await navigator.clipboard.readText(); setCustomJson(current => ({ ...current, [name]: text })); }
    catch (e: any) { setError(e.message ?? String(e)); }
  }

  // Create mock
  const [mockId, setMockId] = useState(initial), [mockName, setMockName] = useState('Captured response'), [timedSse, setTimedSse] = useState(false), [mockSaved, setMockSaved] = useState(false);
  const mockCapture = useCapture(api, mockId, setError);

  // Share
  const [shareId, setShareId] = useState(initial), [fields, setFields] = useState<string[]>(defaultRedactFields), [newField, setNewField] = useState('');
  const shareCapture = useCapture(api, shareId, setError);
  const redacted = useMemo(() => shareCapture ? redactCapture(shareCapture, { fields }) : null, [shareCapture, fields]);
  const addField = () => { const name = newField.trim(); if (name && !fields.some(f => f.toLowerCase() === name.toLowerCase())) setFields([...fields, name]); setNewField(''); };

  const slot = (name: 'A' | 'B', id: string, capture: any, set: (id: string) => void) => {
    const record = records.find(r => r.id === id), text = customJson[name];
    let valid = true;
    if (modes[name] === 'json' && text.trim()) try { JSON.parse(text); } catch { valid = false; }
    return <div className="testing-slot-wrap">
      <div className="testing-source" role="radiogroup" aria-label={`${name} source`}>
        <strong>{name}</strong>
        {(['capture', 'json'] as const).map(mode => <button type="button" key={mode} role="radio" aria-checked={modes[name] === mode} onClick={() => { setModes(current => ({ ...current, [name]: mode })); setPicking(null); }}>{mode === 'capture' ? 'Capture' : 'Custom JSON'}</button>)}
      </div>
      {modes[name] === 'capture' ? <>
        <button type="button" className="testing-slot" aria-label={`Slot ${name}`} aria-expanded={picking === name} onClick={() => setPicking(picking === name ? null : name)}>
          {record ? <><time className="capture-picker-time">{requestTime(record.startedAt)}</time><span className="capture-picker-method" data-method={record.method}>{record.method}</span><span className="capture-picker-url" title={record.url}>{record.url}</span><span className="capture-picker-status">{statusOf(capture) ?? record.status ?? record.statusCode ?? '…'}</span></> : <span className="muted">Choose capture</span>}
        </button>
        {picking === name && <CapturePicker label={`Capture ${name}`} records={records} value={id ? [id] : []} mainSelectionId={selectedId} onChange={ids => { set(ids[0] ?? ''); setPicking(null); }} />}
      </> : <>
        <textarea className="testing-custom-json" aria-label={`Custom JSON ${name}`} placeholder="Paste or type JSON…" spellCheck={false} value={text} onChange={e => setCustomJson(current => ({ ...current, [name]: e.target.value }))} />
        <div className="lab-actions"><button type="button" onClick={() => void pasteClipboard(name)}>Paste</button><button type="button" disabled={!text || !valid} title="Indent the JSON; key order and number text are kept" onClick={() => setCustomJson(current => ({ ...current, [name]: formatJson(text) }))}>Format</button><button type="button" disabled={!text} onClick={() => setCustomJson(current => ({ ...current, [name]: '' }))}>Clear</button>{!valid && <span className="muted">Invalid JSON · compared as text</span>}</div>
      </>}
    </div>;
  };

  return <div className="testing-tools" hidden={!active}>
    {error && <p role="alert" className="error-text">{error}</p>}{notice && <p role="status">{notice}</p>}

    {tab === 'Replay' && <>
      <p className="warn-line" title="Sends a new request through Streamglass. Active rules apply."><TriangleAlert size={14} aria-hidden="true" />Contacts the server; can change data</p>
      <CapturePicker label="Captures to replay" multiple maxSelected={MAX_REPLAY} records={records} value={replayIds} mainSelectionId={selectedId} onChange={setReplayIds} />
      {replayIds.length === 0 && <EmptyState icon={MousePointerClick} title={`Select several to replay in order (up to ${MAX_REPLAY})`}>Select a capture</EmptyState>}
      {single && <>
        <div className="lab-grid"><label>Method<input disabled={!ready} value={replay.method} onChange={e => setReplay({ ...replay, method: e.target.value })} /></label><label>Destination URL<input disabled={!ready} value={replay.url} onChange={e => setReplay({ ...replay, url: e.target.value })} /></label></div>
        <details><summary>Request headers</summary><textarea disabled={!ready} aria-label="Replay request headers" value={replay.headers} onChange={e => setReplay({ ...replay, headers: e.target.value })} /></details>
        <label>Body format<select disabled={!ready} aria-label="Body format" value={bodyMode} onChange={e => { const next = e.target.value as typeof bodyMode; try { if (next === 'text') setBodyText(decodeReplayText(replay.bodyBase64)); else if (bodyReplaced) setReplay({ ...replay, bodyBase64: encodeReplayText(bodyText), headers: JSON.stringify(replayHeaders(JSON.parse(replay.headers), true), null, 2) }); setBodyMode(next); setError(''); } catch { setError('This body cannot be converted to UTF-8 text. Use base64 for binary content.'); } }}><option value="text">Text / JSON</option><option value="base64">Base64 / binary</option></select></label>
        <label>Request body<textarea disabled={!ready} aria-label="Request body" value={bodyMode === 'text' ? bodyText : replay.bodyBase64} onChange={e => { setBodyReplaced(true); if (bodyMode === 'text') setBodyText(e.target.value); else setReplay({ ...replay, bodyBase64: e.target.value }); }} /></label>
        {original?.request?.bodyUnavailable && <p className="error-text">Request body not fully retained. Supply a replacement.</p>}
        <div className="lab-actions"><button className="primary" disabled={busy || !ready || !replay.url || !!original?.isEncrypted || (!!original?.request?.bodyUnavailable && !bodyReplaced)} onClick={() => void act(async () => {
          const textChanged = bodyReplaced && bodyMode === 'text';
          const result = await replayRecord(single, { url: replay.url, method: replay.method, bodyBase64: textChanged ? encodeReplayText(bodyText) : replay.bodyBase64, headers: replayHeaders(JSON.parse(replay.headers), textChanged) });
          setResults([result]);
          if (result.error) throw new Error(result.error);
          setNotice('Sent.');
          await onChanged();
        })}>Send request</button></div>
        {results[0]?.response && <>
          <div className="lab-grid testing-side-by-side"><ResponseSummary capture={original} title="Original response" /><ResponseSummary capture={results[0].response} title="New response" /></div>
          <div className="lab-actions"><button title="Open the new capture in the inspector" onClick={() => onSelect(results[0].resultId!)}>Open</button><button aria-label="Compare with original" title="Compare with original" onClick={() => { setSlotA(single); setSlotB(results[0].resultId!); setSection('response'); onOpenTab('Compare'); }}><ArrowRightLeft size={13} aria-hidden="true" />Compare</button></div>
        </>}
      </>}
      {replayIds.length > 1 && <>
        <div className="lab-actions"><button className="primary" disabled={busy} onClick={() => void act(async () => {
          setResults([]);
          const out: ReplayResult[] = [];
          for (const id of replayIds.slice(0, MAX_REPLAY)) { out.push(await replayRecord(id)); setResults([...out]); }
          await onChanged();
          setNotice(`${out.filter(r => !r.error).length} sent · ${out.filter(r => r.error).length} failed`);
        })}>Replay all ({replayIds.length})</button></div>
        <ul className="testing-results">{replayIds.map(id => {
          const rows = results.filter(r => r.sourceId === id);
          return <li key={id}>
            <div className="testing-result-row"><span className="capture-picker-url" title={recordLabel(id)}>{recordLabel(id)}</span>
              <button disabled={busy} aria-label={`Send ${recordLabel(id)}`} onClick={() => void act(async () => { const r = await replayRecord(id); setResults(prev => [...prev, r]); await onChanged(); if (r.error) throw new Error(r.error); })}>Send</button></div>
            {rows.map(r => <details key={r.key} className="testing-result"><summary>{r.error ? <span className="error-text">Failed: {r.error}</span> : <>Status {r.status ?? 'none'} · {r.durationMs != null ? `${Math.round(r.durationMs)} ms` : 'no timing'}</>}</summary>{r.response?.response && <JsonViewer value={r.response.response.body ?? ''} unavailable={!!r.response.response.bodyUnavailable} />}
              {r.resultId && <div className="lab-actions"><button title="Open in inspector" onClick={() => onSelect(r.resultId!)}>Open</button><button aria-label="Compare with original" title="Compare with original" onClick={() => { setSlotA(id); setSlotB(r.resultId!); setSection('response'); onOpenTab('Compare'); }}>Compare</button></div>}</details>)}
          </li>;
        })}</ul>
      </>}
    </>}

    {tab === 'Compare' && <>
      <div className="lab-grid">{slot('A', slotA, captureA, setSlotA)}{slot('B', slotB, captureB, setSlotB)}</div>
      <div className="lab-actions"><button disabled={!slotA && !slotB && !customJson.A && !customJson.B} onClick={() => { setSlotA(slotB); setSlotB(slotA); setModes(current => ({ A: current.B, B: current.A })); setCustomJson(current => ({ A: current.B, B: current.A })); }}>Swap A and B</button></div>
      <div className="lab-grid"><label>Content<select aria-label="Content" value={section} onChange={e => setSection(e.target.value as typeof section)}><option value="request">Request</option><option value="response">Response</option><option value="events">SSE events</option></select></label><label>Ignore fields or paths<input placeholder="timestamp,id" value={ignore} onChange={e => setIgnore(e.target.value)} /></label><label>Compare only<input placeholder="$.data.items[0]" aria-label="Compare only path" value={focusPath} onChange={e => setFocusPath(e.target.value)} /></label>{section === 'events' && !bodyOnly && <label>Match events by<select aria-label="Match events by" value={eventKey} onChange={e => setEventKey(e.target.value as typeof eventKey)}><option value="sequence">Sequence</option><option value="id">Event ID</option></select></label>}</div>
      {bodyOnly && <p className="muted" title="Status and headers are left out">Body only{focusPath.trim() ? <> · <code>{focusPath.trim()}</code></> : ''}</p>}
      {!sourceA || !sourceB ? (slotA && slotB && !bodyOnly ? <p className="capture-diff-loading" role="status"><Loader2 className="spin" size={14} aria-hidden="true" />Loading captures…</p> : <EmptyState icon={ArrowRightLeft}>Pick A and B</EmptyState>) : <CaptureDiff result={comparison.result} pending={comparison.pending} error={comparison.error} />}
    </>}

    {tab === 'Create mock' && <>
      <CapturePicker label="Capture to mock" records={records} value={mockId ? [mockId] : []} mainSelectionId={selectedId} onChange={ids => { setMockId(ids[0] ?? ''); setMockSaved(false); }} />
      {mockCapture && <ResponseSummary capture={mockCapture} title="Response preview" />}
      <label>Mock name<input value={mockName} onChange={e => setMockName(e.target.value)} /></label>
      <label className="lab-check" title="Replay SSE events with their recorded timing"><input type="checkbox" checked={timedSse} onChange={e => setTimedSse(e.target.checked)} />Keep SSE timing</label>
      <div className="lab-actions"><button disabled={busy || !mockCapture} title="Creates a disabled Map Local rule" onClick={() => void act(async () => { await api(`/api/records/${encodeURIComponent(mockId)}/fixture`, 'POST', { name: mockName, timedSse }); await onChanged(); setMockSaved(true); setNotice('Saved, disabled.'); })}>Save capture as mock</button>
        {mockSaved && <button onClick={() => onOpenTab('Map Local')}>Open in Map Local</button>}</div>
    </>}

    {tab === 'Share' && <>
      <p className="warn-line" title="The preview below is exactly what is exported. Original captures are unchanged."><TriangleAlert size={14} aria-hidden="true" />Redaction is by field name; check for other secrets</p>
      <CapturePicker label="Capture to share" records={records} value={shareId ? [shareId] : []} mainSelectionId={selectedId} onChange={ids => setShareId(ids[0] ?? '')} />
      <fieldset className="testing-redaction"><legend>Redact</legend>
        <div className="testing-fields">{[...new Set([...defaultRedactFields, ...fields])].map(name => <label key={name} className="lab-check"><input type="checkbox" checked={fields.includes(name)} onChange={e => setFields(e.target.checked ? [...fields, name] : fields.filter(f => f !== name))} />{name}</label>)}</div>
        <div className="lab-actions"><input aria-label="Add field" placeholder="Field name" value={newField} onChange={e => setNewField(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addField(); } }} /><button type="button" disabled={!newField.trim()} onClick={addField}>Add</button></div>
      </fieldset>
      {redacted && <><JsonViewer value={redacted} /><div className="lab-actions"><button disabled={busy || !window.streamglass} onClick={() => void act(async () => { await window.streamglass!.exportFile({ name: `streamglass-redacted-${shareId}.json`, content: JSON.stringify(redacted, null, 2) }); setNotice('Redacted export prepared.'); })}>Export redacted capture</button></div></>}
    </>}
  </div>;
}
