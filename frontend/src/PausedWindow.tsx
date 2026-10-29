import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, CirclePause, Lock, Pause, Radio } from 'lucide-react';
import JsonViewer from './JsonViewer';
import JsonBodyEditor from './JsonBodyEditor';
import type { DecodedBody } from './CodecPanel';
import { prepareJson } from './json-viewer.mjs';
import { editableBody, resolvedBody } from './editor-draft.mjs';
import { endedGates, isDisconnect, type EndedGate } from './paused-gates.mjs';
import './editor-window.css';

type Gate = { token: string; recordId: string; stage: string; url?: string; method?: string; pausedAt?: number; value: Record<string, any> };
type EventHistory = { request?: { headers?: [string, string][]; body?: unknown; bodyUnavailable?: boolean }; events?: { event?: string; type?: string; data?: string; timestamp?: string | number; id?: string; sequence?: number }[]; eventCount?: number; captureWarning?: string };
type State = { pending: Gate[]; records?: { id: string; device?: string | null; state?: string; error?: string | null }[] };
type Lost = EndedGate<Gate>;
type Connection = { baseUrl: string; token: string };
type Draft = { url: string; method: string; headers: string; body: string; status: string; event: string };
const params = new URLSearchParams(location.search);
const closeSettleMs = 350;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const hashGate = () => new URLSearchParams(location.hash.replace(/^#/, '')).get('gate');
const stageLabel = (stage: string) => stage === 'event' ? 'SSE event' : stage === 'response' ? 'Response' : 'Request';
// Outgoing request ↗, incoming response ↙, streamed SSE event (radio), each with its own color.
function StageBadge({ stage, compact = false }: { stage: string; compact?: boolean }) {
  const kind = stage === 'event' ? 'event' : stage === 'response' ? 'response' : 'request';
  const Icon = kind === 'event' ? Radio : kind === 'response' ? ArrowDownLeft : ArrowUpRight;
  return compact ? <span className={`editor-stage stage-${kind}`} role="img" aria-label={stageLabel(stage)} title={stageLabel(stage)}><Icon size={11} aria-hidden="true"/></span> : <span className={`editor-stage stage-${kind}`}><Icon size={11} aria-hidden="true"/>{stageLabel(stage)}</span>;
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
    }).catch(() => { if (active) setHistoryError('Context unavailable'); });
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
    <div className="editor-window-content is-gate">
      <div className="editor-flow-context"><div className="editor-flow-meta"><span className="editor-method">{gate.method ?? gate.value.method ?? 'HTTP'}</span><StageBadge stage={gate.stage}/><span className="editor-held" role="status" title="Live traffic is held until you continue or drop it"><Pause size={10} aria-hidden="true"/>Held</span><span className="editor-flow-id" title={`Flow ${gate.recordId}`}>{gate.recordId}</span></div><p>{gate.url ?? gate.value.url ?? draft.url}</p></div>
      <div className="editor-paused-panes">
        {gate.stage !== 'request' && <section className="editor-request-pane" aria-label="Request context"><div className="editor-section-heading"><h2>Request</h2><span title="Read only" aria-label="Read only" role="img"><Lock size={11}/></span></div>{historyError ? <p className="muted">{historyError}</p> : history ? <><h3>Body</h3><JsonViewer value={history.request?.body} unavailable={history.request?.bodyUnavailable}/><details className="headers-disclosure"><summary>Headers ({history.request?.headers?.length ?? 0})</summary><dl className="editor-request-headers">{history.request?.headers?.map(([name, value], index) => <div key={index}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></details></> : <p className="muted">Loading…</p>}</section>}
        <section className="editor-edit-pane" aria-label="Paused traffic editor">
          {gate.stage === 'event' && <section className="editor-event-history sse-history" aria-label="Previous SSE events"><div className="editor-section-heading"><h2>Previous SSE events</h2><span title="Read only. Retained events">{history?.events?.length ?? 0}{history?.eventCount != null && history.eventCount !== history.events?.length ? `/${history.eventCount}` : ''}</span></div>{history?.captureWarning && <p className="editor-history-warning" role="status">{history.captureWarning}</p>}{historyError ? <p className="muted">{historyError}</p> : history ? history.events?.length ? <div className="editor-history-list">{history.events.map((event, index) => <details className="editor-history-event" key={index}><summary><span className="editor-event-number">{String(event.sequence ?? index + 1).padStart(3, '0')}</span><strong>{event.event ?? event.type ?? 'message'}</strong>{event.id && <span>ID {event.id}</span>}<time>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ''}</time></summary><JsonViewer value={event.data}/></details>)}</div> : <p className="muted">None</p> : <p className="muted">Loading…</p>}</section>}
          <div className="editor-section-heading editor-current-heading"><h2>{gate.stage === 'event' ? 'Paused event' : `Paused ${gate.stage}`}</h2></div>
          <fieldset className="editor-fields form" disabled={busy}>
            {gate.stage === 'request' && <><label>URL<input value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })}/></label><label>Method<input value={draft.method} onChange={event => setDraft({ ...draft, method: event.target.value })}/></label></>}
            {gate.stage === 'response' && <label>Status code<input type="number" value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value })}/></label>}
            {gate.stage === 'event' && <label>Event type<input value={draft.event} onChange={event => setDraft({ ...draft, event: event.target.value })}/></label>}
            {gate.stage === 'response' && <div><button type="button" onClick={() => setBodyMode('raw')}>Raw body</button><button type="button" onClick={async () => { try { if (!decoded) { const result = await api(`/api/pending/${encodeURIComponent(gate.token)}/decode`, 'POST', {}) as DecodedBody; setDecoded(result); setDecodedText(result.body); } setBodyMode('decoded'); setError(''); } catch (e) { setError(errorMessage(e)); } }}>Decoded body</button>{decoded && <button type="button" onClick={() => { setDecoded(null); setDecodedText(''); setBodyMode('raw'); }}>Discard decoded</button>}{decoded && <p className="muted" title="Decoded edits are re-encoded on Continue">{decoded.warning}{decodedText !== decoded.body ? ' · edited' : ''}</p>}</div>}
            {bodyMode === 'decoded' && decoded ? <JsonBodyEditor label="Decoded response body" value={decodedText} disabled={!decoded.editable} onChange={setDecodedText} onReplacingChange={setReplacingBody}/> : <div className="editor-body-field"><span className="editor-body-heading"><span>{gate.stage === 'event' ? 'Event data' : 'Body'}</span><button type="button" title="Unchanged JSON keeps its original bytes" disabled={Boolean(gate.value.bodyUnavailable) || replacingBody || Boolean(decoded)} onClick={() => { const formatted = prepareJson(draft.body); if (!formatted.isJson) { setError('Not valid JSON'); return; } setDraft({ ...draft, body: formatted.text }); setError(''); }}>Format JSON</button></span><JsonBodyEditor key={gate.token} label={gate.stage === 'event' ? 'Event data' : 'Body'} disabled={Boolean(gate.value.bodyUnavailable) || Boolean(decoded)} value={draft.body} onChange={body => setDraft({ ...draft, body })} onReplacingChange={setReplacingBody}/>{Boolean(gate.value.bodyUnavailable) && <small>{gate.value.bodyUnavailableReason || 'Body unavailable'}</small>}</div>}
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
  const [lost, setLost] = useState<Lost[]>([]);
  const previousOrder = useRef<string[]>([]);
  const seenGates = useRef(new Map<string, Gate>());

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
    let etag = '';
    async function refresh() {
      // An unchanged snapshot comes back as a few bytes; keep the previous state then.
      try { const state = await api(`/api/state${etag ? `?etag=${encodeURIComponent(etag)}` : ''}`) as State & { unchanged?: boolean; etag?: string }; if (active && !state.unchanged) { etag = state.etag ?? ''; setData(state); } }
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

  // A gate that vanishes without being resolved here and whose flow ended in an error was cut off: usually the
  // app (or the server) stopped waiting on its own timeout. Keep the window open and say so instead of closing.
  useEffect(() => {
    if (!data) return;
    const live = new Map(data.pending.map(gate => [gate.token, gate]));
    const ended = endedGates(seenGates.current, live, resolved, data.records);
    seenGates.current = live;
    if (ended.length) setLost(old => [...old, ...ended]);
  }, [data, resolved]);

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

  // Close once the last paused request is handled; a window opened with nothing paused stays open. No grace
  // period: the list is empty only after a fresh /api/pending read agrees, so a transient empty state (load,
  // refresh, an optimistic local resolve) never closes it. A gate that arrives after that read but before
  // close() is covered by the main process, which forgets this window as soon as it starts closing and opens a
  // new one for the gate. If the cleanup runs first (a gate shows up in the list), the pending close is abandoned.
  const hadGates = useRef(false);
  const loaded = Boolean(data);
  useEffect(() => {
    if (!loaded) return;
    if (gates.length) { hadGates.current = true; return; }
    if (!hadGates.current || lost.length) return;
    let active = true;
    // A continued request is usually followed within milliseconds by its response or SSE event gate; this
    // invisible settle keeps that follow-up in this window instead of closing and reopening it.
    const timer = setTimeout(() => {
      api('/api/pending').then((fresh: { pending?: unknown[] }) => { if (active && !fresh.pending?.length) window.close(); }).catch(() => { /* Keep the window; the next poll retries. */ });
    }, closeSettleMs);
    return () => { active = false; clearTimeout(timer); };
  }, [loaded, gates.length, lost.length, api]);

  const draft = current ? drafts[current.token] ?? draftFor(current) : null;
  const onResolved = useCallback((token: string, message: string) => {
    setResolved(old => new Set(old).add(token)); setNotice(message);
  }, []);

  return <main className="editor-window paused-window">
    <header className="editor-window-heading window-header"><h1>Breakpoints</h1><span>{gates.length ? `${gates.length} paused` : 'Nothing paused'}</span></header>
    {error && <div className="editor-error" role="alert"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
    {lost.map(({ gate, reason, pausedMs }) => {
      const { path } = splitUrl(gate.url ?? gate.value.url);
      return <div key={gate.token} className="editor-error paused-lost" role="alert">
        <span title={isDisconnect(reason) ? 'The app or the server stopped waiting, usually on its own timeout. Continue sooner, or raise the app timeout while debugging.' : undefined}><strong>{gate.method ?? gate.value.method ?? 'HTTP'} {path || '/'}</strong> ended after {formatWait(pausedMs)} at {stageLabel(gate.stage).toLowerCase()}: {reason}. Edits not sent.</span>
        <button onClick={() => setLost(old => old.filter(item => item.gate.token !== gate.token))}>Dismiss</button>
      </div>;
    })}
    <div className="paused-layout">
      <nav className="paused-list" aria-label="Paused requests">
        {gates.map(gate => {
          const { host, path } = splitUrl(gate.url ?? gate.value.url);
          const device = devices.get(gate.recordId);
          const method = gate.method ?? gate.value.method ?? 'HTTP';
          return <button key={gate.token} className={`paused-item${gate.token === selected ? ' selected' : ''}`} title={[`${host}${path}`, device].filter(Boolean).join(' · ')} aria-current={gate.token === selected ? 'true' : undefined} onClick={() => setSelected(gate.token)}>
            <span className="editor-method">{method}</span><span className="paused-url"><b>{path || '/'}</b></span><StageBadge stage={gate.stage} compact/><time className="paused-wait">{formatWait(now - (gate.pausedAt ?? now))}</time>
          </button>;
        })}
      </nav>
      <section className="paused-detail">
        {!data ? <p className="muted paused-empty">Connecting…</p> : current && draft ? <GateEditor key={current.token} gate={current} draft={draft} setDraft={next => setDrafts(old => ({ ...old, [current.token]: next }))} api={api} onResolved={onResolved} setError={setError}/>
          : <div className="paused-empty"><CirclePause aria-hidden="true"/><h2>Nothing paused</h2>{notice && <p className="muted">{notice}</p>}</div>}
      </section>
    </div>
  </main>;
}
