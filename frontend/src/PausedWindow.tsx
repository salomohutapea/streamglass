import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Radio } from 'lucide-react';
import JsonViewer from './JsonViewer';
import JsonBodyEditor from './JsonBodyEditor';
import type { DecodedBody } from './CodecPanel';
import { prepareJson } from './json-viewer.mjs';
import { editableBody, resolvedBody } from './editor-draft.mjs';
import './editor-window.css';

type Gate = { token: string; recordId: string; stage: string; url?: string; method?: string; pausedAt?: number; value: Record<string, any> };
type EventHistory = { request?: { headers?: [string, string][]; body?: unknown; bodyUnavailable?: boolean }; events?: { event?: string; type?: string; data?: string; timestamp?: string | number; id?: string; sequence?: number }[]; eventCount?: number; captureWarning?: string };
type State = { pending: Gate[]; records?: { id: string; device?: string | null }[] };
type Connection = { baseUrl: string; token: string };
type Draft = { url: string; method: string; headers: string; body: string; status: string; event: string };
const params = new URLSearchParams(location.search);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const hashGate = () => new URLSearchParams(location.hash.replace(/^#/, '')).get('gate');
const stageLabel = (stage: string) => stage === 'event' ? 'SSE event' : stage === 'response' ? 'Response' : 'Request';
// Outgoing request ↗, incoming response ↙, streamed SSE event (radio), each with its own color.
function StageBadge({ stage }: { stage: string }) {
  const kind = stage === 'event' ? 'event' : stage === 'response' ? 'response' : 'request';
  const Icon = kind === 'event' ? Radio : kind === 'response' ? ArrowDownLeft : ArrowUpRight;
  return <span className={`editor-stage stage-${kind}`}><Icon size={11} aria-hidden="true"/>{stageLabel(stage)}</span>;
}

export function formatWait(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
function splitUrl(url = '') {
  try { const parsed = new URL(url); return { host: parsed.host, path: parsed.pathname + parsed.search }; }
  catch { return { host: '', path: url }; }
}
const draftFor = (gate: Gate): Draft => {
  const value = gate.value;
  return { url: value.url ?? gate.url ?? '', method: value.method ?? gate.method ?? '', headers: JSON.stringify(value.headers ?? [], null, 2), body: editableBody(gate.stage === 'event' ? value.data : value.body), status: String(value.statusCode ?? 200), event: value.event ?? 'message' };
};

type EditorProps = { gate: Gate; draft: Draft; setDraft(draft: Draft): void; api(path: string, method?: string, body?: unknown): Promise<any>; onResolved(token: string, message: string): void; setError(message: string): void };

function GateEditor({ gate, draft, setDraft, api, onResolved, setError }: EditorProps) {
  const [busy, setBusy] = useState(false);
  const [replacingBody, setReplacingBody] = useState(false);
  const [history, setHistory] = useState<EventHistory | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [decoded, setDecoded] = useState<DecodedBody | null>(null);
  const [decodedText, setDecodedText] = useState('');
  const [bodyMode, setBodyMode] = useState<'raw' | 'decoded'>('raw');
  const working = useRef(false);

  useEffect(() => {
    if (gate.stage === 'request') return;
    let active = true;
    api(`/api/records/${encodeURIComponent(gate.recordId)}`).then((record: EventHistory) => {
      if (!active) return;
      const sequence = gate.value.sequence;
      setHistory({ ...record, events: record.events?.filter(event => typeof sequence !== 'number' || typeof event.sequence !== 'number' || event.sequence < sequence) });
      setHistoryError('');
    }).catch(() => { if (active) setHistoryError('Request context and previous events are unavailable. The capture may have been removed.'); });
    return () => { active = false; };
  }, [api, gate.recordId, gate.stage, gate.value.sequence]);

  async function resolveGate(action: 'continue' | 'drop') {
    if (working.current || replacingBody) return;
    working.current = true; setBusy(true); setError('');
    try {
      let value = gate.value;
      if (action === 'continue') {
        value = { ...gate.value };
        if (gate.stage === 'event') { value.event = draft.event; value.data = resolvedBody(draft.body, gate.value.data); }
        else {
          const headers = JSON.parse(draft.headers);
          if (!Array.isArray(headers) || headers.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(item => typeof item !== 'string'))) throw new Error('Headers must be JSON pairs of strings: [["Name", "value"]].');
          value.headers = headers;
          if (draft.body !== editableBody(gate.value.body)) value.body = draft.body;
          if (gate.stage === 'request') { value.url = draft.url; value.method = draft.method; }
          else {
            const status = Number(draft.status);
            if (!Number.isInteger(status) || (!(status >= 200 && status <= 599) && !(status === 101 && gate.value.statusCode === 101))) throw new Error('Use a status code from 200 to 599.');
            value.statusCode = status;
          }
        }
      }
      await api(`/api/pending/${encodeURIComponent(gate.token)}`, 'POST', { action, ...(action === 'continue' ? { value, ...(decoded && decodedText !== decoded.body ? { decoded: { codecId: decoded.codecId, body: decodedText } } : {}) } : {}) });
      onResolved(gate.token, action === 'drop' ? 'Connection dropped.' : 'Traffic continued.');
    } catch (error) { setError(errorMessage(error)); }
    finally { working.current = false; setBusy(false); }
  }

  useEffect(() => {
    const continueOnShortcut = (event: KeyboardEvent) => {
      if (!busy && !replacingBody && event.metaKey && event.key === 'Enter' && !event.repeat && !event.isComposing) {
        event.preventDefault();
        void resolveGate('continue');
      }
    };
    window.addEventListener('keydown', continueOnShortcut);
    return () => window.removeEventListener('keydown', continueOnShortcut);
  });

  return <>
    <div className="editor-window-content">
      <p className="editor-status" role="status">{`Paused before ${gate.stage === 'event' ? 'this SSE event is delivered' : `the ${gate.stage} continues`}.`}</p>
      <div className="editor-flow-context"><div className="editor-flow-meta"><span className="editor-method">{gate.method ?? gate.value.method ?? 'HTTP'}</span><StageBadge stage={gate.stage}/><span className="editor-flow-id" title={gate.recordId}>Flow {gate.recordId}</span></div><p>{gate.url ?? gate.value.url ?? draft.url}</p></div>
      <div className={gate.stage === 'request' ? '' : 'editor-paused-panes'}>
        {gate.stage !== 'request' && <section className="editor-request-pane" aria-label="Request context"><div className="editor-section-heading"><h2>Request</h2><span>Read only</span></div><dl className="editor-context"><dt>Method</dt><dd>{gate.method ?? 'HTTP'}</dd><dt>URL</dt><dd>{gate.url}</dd></dl>{historyError ? <p className="muted">{historyError}</p> : history ? <><h3>Body</h3><JsonViewer value={history.request?.body} unavailable={history.request?.bodyUnavailable}/><details className="headers-disclosure"><summary>Headers ({history.request?.headers?.length ?? 0})</summary><dl className="editor-request-headers">{history.request?.headers?.map(([name, value], index) => <div key={index}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></details></> : <p className="muted">Loading request…</p>}</section>}
        <section className="editor-edit-pane" aria-label="Paused traffic editor">
          {gate.stage === 'event' && <section className="editor-event-history sse-history" aria-label="Previous SSE events"><div className="editor-section-heading"><h2>Previous SSE events</h2><span>{history?.events?.length ?? 0} retained{history?.eventCount != null && history.eventCount !== history.events?.length ? ` of ${history.eventCount}` : ''}</span></div><p className="muted">Read only · select text and press ⌘C to copy. The paused event is editable below.</p>{history?.captureWarning && <p className="editor-history-warning" role="status">{history.captureWarning}</p>}{historyError ? <p className="muted">{historyError}</p> : history ? history.events?.length ? <div className="editor-history-list">{history.events.map((event, index) => <details className="editor-history-event" key={index}><summary><span className="editor-event-number">{String(event.sequence ?? index + 1).padStart(3, '0')}</span><strong>{event.event ?? event.type ?? 'message'}</strong>{event.id && <span>ID {event.id}</span>}<time>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ''}</time></summary><JsonViewer value={event.data}/></details>)}</div> : <p className="muted">No previous events have been retained.</p> : <p className="muted">Loading previous events…</p>}</section>}
          <div className="editor-section-heading editor-current-heading"><h2>{gate.stage === 'event' ? 'Paused event' : `Paused ${gate.stage}`}</h2><span>Editable</span></div>
          <fieldset className="editor-fields form" disabled={busy}>
            {gate.stage === 'request' && <><label>URL<input value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })}/></label><label>Method<input value={draft.method} onChange={event => setDraft({ ...draft, method: event.target.value })}/></label></>}
            {gate.stage === 'response' && <label>Status code<input type="number" value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value })}/></label>}
            {gate.stage === 'event' && <label>Event type<input value={draft.event} onChange={event => setDraft({ ...draft, event: event.target.value })}/></label>}
            {gate.stage === 'response' && <div><button type="button" onClick={() => setBodyMode('raw')}>Raw body</button><button type="button" onClick={async () => { try { if (!decoded) { const result = await api(`/api/pending/${encodeURIComponent(gate.token)}/decode`, 'POST', {}) as DecodedBody; setDecoded(result); setDecodedText(result.body); } setBodyMode('decoded'); setError(''); } catch (e) { setError(errorMessage(e)); } }}>Decoded body</button>{decoded && <button type="button" onClick={() => { setDecoded(null); setDecodedText(''); setBodyMode('raw'); }}>Discard decoded view and edits</button>}{decoded && <p className="muted">{decoded.warning} {decodedText !== decoded.body ? 'Decoded changes will be re-encoded on Continue.' : ''}</p>}</div>}
            {bodyMode === 'decoded' && decoded ? <JsonBodyEditor label="Decoded response body" value={decodedText} disabled={!decoded.editable} onChange={setDecodedText} onReplacingChange={setReplacingBody}/> : <div className="editor-body-field"><span className="editor-body-heading"><span>{gate.stage === 'event' ? 'Event data' : 'Body'}</span><button type="button" disabled={Boolean(gate.value.bodyUnavailable) || replacingBody || Boolean(decoded)} onClick={() => { const formatted = prepareJson(draft.body); if (!formatted.isJson) { setError('This body is not valid JSON. Correct it before formatting.'); return; } setDraft({ ...draft, body: formatted.text }); setError(''); }}>Format JSON</button></span><JsonBodyEditor key={gate.token} label={gate.stage === 'event' ? 'Event data' : 'Body'} disabled={Boolean(gate.value.bodyUnavailable) || Boolean(decoded)} value={draft.body} onChange={body => setDraft({ ...draft, body })} onReplacingChange={setReplacingBody}/><small>{gate.value.bodyUnavailable ? gate.value.bodyUnavailableReason || 'Body is unavailable for editing.' : 'JSON is formatted for readability. Leaving it unchanged preserves its original bytes.'}</small></div>}
            {gate.stage !== 'event' && <details key={gate.token} className="headers-disclosure"><summary>Headers ({gate.value.headers?.length ?? 0})</summary><label className="editor-headers-field">Headers (JSON pairs)<textarea className="mono" rows={7} spellCheck={false} value={draft.headers} onChange={event => setDraft({ ...draft, headers: event.target.value })}/></label></details>}
          </fieldset>
        </section>
      </div>
    </div>
    <footer className="editor-window-footer">
      <button className="error-text" disabled={busy || replacingBody} onClick={() => void resolveGate('drop')}>Drop connection</button>
      <button className="primary" aria-label="Continue" aria-keyshortcuts="Meta+Enter" disabled={busy || replacingBody} onClick={() => void resolveGate('continue')}>Continue <span aria-hidden="true">⌘↵</span></button>
    </footer>
  </>;
}

export default function PausedWindow() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [data, setData] = useState<State | null>(null);
  const [selected, setSelected] = useState<string | null>(hashGate());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const previousOrder = useRef<string[]>([]);

  useEffect(() => {
    document.title = 'Breakpoints — Streamglass';
    document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark';
    const theme = (event: StorageEvent) => { if (event.key === 'theme') document.documentElement.dataset.theme = event.newValue || 'dark'; };
    const deepLink = () => { const gate = hashGate(); if (gate) setSelected(gate); };
    window.addEventListener('storage', theme);
    window.addEventListener('hashchange', deepLink);
    let active = true;
    (window.streamglass?.getBootstrap() ?? Promise.resolve({ baseUrl: 'http://127.0.0.1:48721', token: params.get('token') || '' }))
      .then(value => { if (active) setConnection(value); }).catch(error => { if (active) setError(errorMessage(error)); });
    return () => { active = false; window.removeEventListener('storage', theme); window.removeEventListener('hashchange', deepLink); };
  }, []);

  const api = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    if (!connection) throw new Error('Backend is connecting');
    const response = await fetch(connection.baseUrl + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try { message = JSON.parse(text).error?.message || text; } catch { /* Plain text backend error. */ }
      throw new Error(message || `Request failed (${response.status})`);
    }
    return response.status === 204 ? undefined : response.json();
  }, [connection]);

  useEffect(() => {
    if (!connection) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const state = await api('/api/state') as State; if (active) setData(state); }
      catch (error) { if (active) setError(errorMessage(error)); }
      finally { if (active) timer = setTimeout(refresh, 1000); }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [connection, api]);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  // Oldest first. Server order is creation order, so it breaks ties for equal timestamps.
  const gates = useMemo(() => (data?.pending ?? []).map((gate, index) => ({ gate, index })).filter(({ gate }) => !resolved.has(gate.token))
    .sort((a, b) => (a.gate.pausedAt ?? 0) - (b.gate.pausedAt ?? 0) || a.index - b.index).map(({ gate }) => gate), [data, resolved]);
  const devices = useMemo(() => new Map((data?.records ?? []).map(record => [record.id, record.device])), [data]);
  const current = gates.find(gate => gate.token === selected) ?? null;

  useEffect(() => {
    if (!data) return;
    const live = new Set(data.pending.map(gate => gate.token));
    setResolved(old => old.size && [...old].some(token => !live.has(token)) ? new Set([...old].filter(token => live.has(token))) : old);
    setDrafts(old => Object.keys(old).some(token => !live.has(token)) ? Object.fromEntries(Object.entries(old).filter(([token]) => live.has(token))) : old);
  }, [data]);

  // When the selected gate is gone (resolved here, by MCP, or released by pause), move to the next oldest.
  useEffect(() => {
    if (!data) return;
    const order = gates.map(gate => gate.token);
    if (!current) {
      const before = previousOrder.current;
      const position = selected ? before.indexOf(selected) : -1;
      const next = position >= 0 ? before.slice(position + 1).find(token => order.includes(token)) : undefined;
      const target = next ?? order[0] ?? null;
      if (target !== selected) setSelected(target);
    }
    previousOrder.current = order;
  }, [data, gates, current, selected]);

  // Close once the last paused request is handled; a window opened with nothing paused stays open.
  const hadGates = useRef(false);
  const loaded = Boolean(data);
  useEffect(() => {
    if (!loaded) return;
    if (gates.length) { hadGates.current = true; return; }
    if (!hadGates.current) return;
    // Grace period: a continued response is often followed at once by its SSE event (or a request by its response).
    const timer = setTimeout(() => window.close(), 2500);
    return () => clearTimeout(timer);
  }, [loaded, gates.length]);

  const draft = current ? drafts[current.token] ?? draftFor(current) : null;
  const onResolved = useCallback((token: string, message: string) => {
    setResolved(old => new Set(old).add(token)); setNotice(message);
  }, []);

  return <main className="editor-window paused-window">
    <header className="editor-window-heading window-header"><h1>Breakpoints</h1><span>{gates.length ? `${gates.length} paused` : 'Nothing paused'}</span></header>
    {error && <div className="editor-error" role="alert"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="paused-layout">
      <nav className="paused-list" aria-label="Paused requests">
        {gates.map(gate => {
          const { host, path } = splitUrl(gate.url ?? gate.value.url);
          const device = devices.get(gate.recordId);
          return <button key={gate.token} className={`paused-item${gate.token === selected ? ' selected' : ''}`} aria-current={gate.token === selected ? 'true' : undefined} onClick={() => setSelected(gate.token)}>
            <span className="paused-item-top"><span className="editor-method">{gate.method ?? gate.value.method ?? 'HTTP'}</span><StageBadge stage={gate.stage}/><time className="paused-wait">{formatWait(now - (gate.pausedAt ?? now))}</time></span>
            <span className="paused-url" title={gate.url}><b>{path || '/'}</b>{host && <small>{host}</small>}</span>
            {device && <span className="paused-device">{device}</span>}
          </button>;
        })}
      </nav>
      <section className="paused-detail">
        {!data ? <p className="muted paused-empty">Connecting…</p> : current && draft ? <GateEditor key={current.token} gate={current} draft={draft} setDraft={next => setDrafts(old => ({ ...old, [current.token]: next }))} api={api} onResolved={onResolved} setError={setError}/>
          : <div className="paused-empty"><h2>No paused requests</h2><p className="muted">{notice || 'Matching breakpoints pause here until you continue or drop them.'}</p></div>}
      </section>
    </div>
  </main>;
}
