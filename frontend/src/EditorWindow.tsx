import { useCallback, useEffect, useRef, useState } from 'react';
import { Folder, Plus } from 'lucide-react';
import RuleList from './RuleList';
import JsonViewer from './JsonViewer';
import JsonBodyEditor from './JsonBodyEditor';
import type { DecodedBody } from './CodecPanel';
import { prepareJson } from './json-viewer.mjs';
import { editableBody, resolvedBody } from './editor-draft.mjs';
import { upsertRule } from './rule-order.mjs';
import './editor-window.css';

type Rule = { id: string; name?: string; enabled: boolean; pattern: string; method: string; stages: string[]; script?: string; breakpoint?: boolean; folderId?: string };
type RuleFolder = { id: string; name: string; kind: 'breakpoints' | 'scripts' };
type Gate = { token: string; recordId: string; stage: string; url?: string; method?: string; value: Record<string, any> };
type EventHistory = { request?: { headers?: [string, string][]; body?: unknown; bodyUnavailable?: boolean }; events?: { event?: string; type?: string; data?: string; timestamp?: string | number; id?: string; sequence?: number }[]; eventCount?: number; captureWarning?: string };
type State = { rules: Rule[]; rulesRevision: number; pending: Gate[]; folders: RuleFolder[] };
type Connection = { baseUrl: string; token: string };
type Draft = { url: string; method: string; headers: string; body: string; status: string; event: string };
const params = new URLSearchParams(location.search);
const mode = params.get('editor');
const recordId = params.get('record');
const token = params.get('gate');
const scriptTemplate = `async function onRequest(context, url, request) {
  return request;
}

async function onResponse(context, url, request, response) {
  return response;
}

async function onEvent(context, url, request, event) {
  return event;
}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const newRule = (): Rule => ({ id: crypto.randomUUID(), name: mode === 'scripts' ? 'Untitled script' : 'Untitled rule', enabled: true, pattern: '*', method: '*', stages: ['request'], breakpoint: mode !== 'scripts', ...(mode === 'scripts' ? { script: scriptTemplate } : {}) });

export default function EditorWindow() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [data, setData] = useState<State | null>(null);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const [selectedFolder, setSelectedFolder] = useState('all');
  const [folderForm, setFolderForm] = useState<{ id?: string; name: string } | null>(null);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [seedLoading, setSeedLoading] = useState(Boolean(recordId && mode !== 'paused'));
  const [gate, setGate] = useState<Gate | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [completed, setCompleted] = useState('');
  const [replacingBody, setReplacingBody] = useState(false);
  const [history, setHistory] = useState<EventHistory | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [decoded, setDecoded] = useState<DecodedBody | null>(null);
  const [decodedText, setDecodedText] = useState('');
  const [bodyMode, setBodyMode] = useState<'raw' | 'decoded'>('raw');
  const initializedGate = useRef(false);
  const revision = useRef(0);
  const working = useRef(false);
  const title = mode === 'paused' ? 'Paused traffic' : mode === 'scripts' ? 'JavaScript rules' : 'Breakpoint rules';
  const kind = mode === 'scripts' ? 'scripts' : 'breakpoints';
  const folders = data?.folders?.filter(folder => folder.kind === kind) ?? [];
  const rules = data?.rules.filter(rule => mode === 'scripts' ? rule.breakpoint === false : rule.breakpoint !== false) ?? [];
  const activeFolder = folders.find(folder => folder.id === selectedFolder);
  const visibleRules = rules.filter(rule => selectedFolder === 'all' || (selectedFolder === 'ungrouped' ? !rule.folderId : rule.folderId === selectedFolder));

  useEffect(() => {
    if (data && selectedFolder !== 'all' && selectedFolder !== 'ungrouped' && !data.folders?.some(folder => folder.id === selectedFolder)) {
      setSelectedFolder('ungrouped'); setFolderForm(null); setConfirmDeleteFolder(false);
    }
  }, [data, selectedFolder]);

  useEffect(() => {
    document.title = `${title} — Streamglass`;
    document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark';
    const theme = (event: StorageEvent) => { if (event.key === 'theme') document.documentElement.dataset.theme = event.newValue || 'dark'; };
    window.addEventListener('storage', theme);
    let active = true;
    (window.streamglass?.getBootstrap() ?? Promise.resolve({ baseUrl: 'http://127.0.0.1:48721', token: params.get('token') || '' }))
      .then(value => { if (active) setConnection(value); }).catch(error => { if (active) setError(errorMessage(error)); });
    return () => { active = false; window.removeEventListener('storage', theme); };
  }, [title]);

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
      const current = revision.current;
      try {
        const state = await api('/api/state') as State;
        if (active && current === revision.current) {
          setData(state);
          if (mode === 'paused' && !initializedGate.current) {
            const pending = state.pending.find(item => item.token === token);
            if (pending) {
              const value = pending.value;
              setGate(pending);
              setDraft({ url: value.url ?? pending.url ?? '', method: value.method ?? pending.method ?? '', headers: JSON.stringify(value.headers ?? [], null, 2), body: editableBody(pending.stage === 'event' ? value.data : value.body), status: String(value.statusCode ?? 200), event: value.event ?? 'message' });
              initializedGate.current = true;
            }
          }
          const paused = state.pending.find(item => item.token === token);
          if (mode === 'paused' && paused && paused.stage !== 'request') {
            try {
              const record = await api(`/api/records/${encodeURIComponent(paused.recordId)}`) as EventHistory;
              if (active && current === revision.current) {
                const sequence = paused.value.sequence;
                setHistory({ ...record, events: record.events?.filter(event => typeof sequence !== 'number' || typeof event.sequence !== 'number' || event.sequence < sequence) });
                setHistoryError('');
              }
            } catch { if (active) setHistoryError('Request context and previous events are unavailable. The capture may have been removed.'); }
          }
        }
      } catch (error) { if (active && current === revision.current) setError(errorMessage(error)); }
      finally { if (active) timer = setTimeout(refresh, 1000); }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [connection, api]);

  useEffect(() => {
    if (!connection || !recordId || mode === 'paused') return;
    let active = true;
    api(`/api/records/${encodeURIComponent(recordId)}`).then(record => {
      if (!active) return;
      if (record.isEncrypted || record.kind === 'tunnel') throw new Error('Encrypted connections cannot seed inspection rules.');
      setEditing({ ...newRule(), pattern: record.url, method: record.method });
    }).catch(error => { if (active) setError(errorMessage(error)); }).finally(() => { if (active) setSeedLoading(false); });
    return () => { active = false; };
  }, [connection, api]);

  async function mutateRules(change: (rules: Rule[]) => Rule[], expectedRevision?: number | null) {
    if (working.current) return;
    working.current = true;
    revision.current++;
    setBusy(true); setError('');
    try {
      const latest = await api('/api/state') as State;
      const result = await api('/api/rules', 'PUT', { revision: expectedRevision ?? latest.rulesRevision, rules: change(latest.rules) });
      setData({ ...latest, rules: result.rules, rulesRevision: result.revision });
      return true;
    } catch (error) { setError(errorMessage(error)); return false; }
    finally { revision.current++; working.current = false; setBusy(false); }
  }
  async function saveRule() {
    if (!editing) return;
    if (!editing.pattern.trim() || !editing.stages.length) { setError('Enter a URL wildcard and select at least one stage.'); return; }
    if (await mutateRules(rules => upsertRule(rules, editing), editingRevision)) { setEditing(null); setEditingRevision(null); }
  }
  async function saveFolder() {
    if (!folderForm || working.current) return;
    const name = folderForm.name.trim();
    if (!name) { setError('Enter a folder name.'); return; }
    working.current = true; revision.current++; setBusy(true); setError('');
    try {
      const folder = await api(folderForm.id ? `/api/folders/${encodeURIComponent(folderForm.id)}` : '/api/folders', folderForm.id ? 'PATCH' : 'POST', folderForm.id ? { name } : { name, kind }) as RuleFolder;
      const latest = await api('/api/state') as State;
      setData(latest); setSelectedFolder(folder.id); setFolderForm(null);
    } catch (error) { setError(errorMessage(error)); }
    finally { revision.current++; working.current = false; setBusy(false); }
  }
  async function deleteFolder() {
    if (!activeFolder || working.current) return;
    working.current = true; revision.current++; setBusy(true); setError('');
    try {
      await api(`/api/folders/${encodeURIComponent(activeFolder.id)}`, 'DELETE');
      const latest = await api('/api/state') as State;
      setData(latest); setSelectedFolder('ungrouped'); setConfirmDeleteFolder(false); setFolderForm(null);
    } catch (error) { setError(errorMessage(error)); }
    finally { revision.current++; working.current = false; setBusy(false); }
  }
  const pending = Boolean(gate && data?.pending.some(item => item.token === gate.token) && !completed);
  async function resolveGate(action: 'continue' | 'drop') {
    if (!gate || !draft || !pending || working.current || replacingBody) return;
    working.current = true; revision.current++; setBusy(true); setError('');
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
      if (action === 'continue') setDraft({ url: value.url ?? gate.url ?? '', method: value.method ?? gate.method ?? '', headers: JSON.stringify(value.headers ?? [], null, 2), body: editableBody(gate.stage === 'event' ? value.data : value.body), status: String(value.statusCode ?? 200), event: value.event ?? 'message' });
      setCompleted(action === 'drop' ? 'Connection dropped.' : 'Traffic continued.');
      window.close();
    } catch (error) { setError(errorMessage(error)); }
    finally { revision.current++; working.current = false; setBusy(false); }
  }

  useEffect(() => {
    const continueOnShortcut = (event: KeyboardEvent) => {
      if (mode === 'paused' && pending && !busy && !replacingBody && event.metaKey && event.key === 'Enter' && !event.repeat && !event.isComposing) {
        event.preventDefault();
        void resolveGate('continue');
      }
    };
    window.addEventListener('keydown', continueOnShortcut);
    return () => window.removeEventListener('keydown', continueOnShortcut);
  });

  return <main className="editor-window">
    <header className="editor-window-heading"><h1>{title}</h1><span>{mode === 'paused' ? gate?.stage ?? 'Breakpoint' : 'Applies to all connected devices'}</span></header>
    {error && <div className="editor-error" role="alert"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="editor-window-content">
      {mode === 'paused' ? <>
        <p className="editor-status" role="status">{completed || (!data ? 'Connecting…' : pending ? `Paused before ${gate?.stage === 'event' ? 'this SSE event is delivered' : `the ${gate?.stage} continues`}.` : 'This breakpoint is no longer pending. The traffic may have continued, expired, or been dropped.')}</p>
        {gate && draft && <><div className="editor-flow-context"><div className="editor-flow-meta"><span className="editor-method">{gate.method ?? gate.value.method ?? 'HTTP'}</span><span className="editor-stage">{gate.stage === 'event' ? 'SSE event' : gate.stage}</span><span className="editor-flow-id" title={gate.recordId}>Flow {gate.recordId}</span></div><p>{gate.url ?? gate.value.url ?? draft.url}</p></div>
          <div className={gate.stage === 'request' ? '' : 'editor-paused-panes'}>
          {gate.stage !== 'request' && <section className="editor-request-pane" aria-label="Request context"><div className="editor-section-heading"><h2>Request</h2><span>Read only</span></div><dl className="editor-context"><dt>Method</dt><dd>{gate.method ?? 'HTTP'}</dd><dt>URL</dt><dd>{gate.url}</dd></dl>{historyError ? <p className="muted">{historyError}</p> : history ? <><h3>Body</h3><JsonViewer value={history.request?.body} unavailable={history.request?.bodyUnavailable}/><details className="headers-disclosure"><summary>Headers ({history.request?.headers?.length ?? 0})</summary><dl className="editor-request-headers">{history.request?.headers?.map(([name, value], index) => <div key={index}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></details></> : <p className="muted">Loading request…</p>}</section>}
          <section className="editor-edit-pane" aria-label="Paused traffic editor">
          {gate.stage === 'event' && <section className="editor-event-history sse-history" aria-label="Previous SSE events"><div className="editor-section-heading"><h2>Previous SSE events</h2><span>{history?.events?.length ?? 0} retained{history?.eventCount != null && history.eventCount !== history.events?.length ? ` of ${history.eventCount}` : ''}</span></div><p className="muted">Read only · select text and press ⌘C to copy. The paused event is editable below.</p>{history?.captureWarning && <p className="editor-history-warning" role="status">{history.captureWarning}</p>}{historyError ? <p className="muted">{historyError}</p> : history ? history.events?.length ? <div className="editor-history-list">{history.events.map((event, index) => <details className="editor-history-event" key={index}><summary><span className="editor-event-number">{String(event.sequence ?? index + 1).padStart(3, '0')}</span><strong>{event.event ?? event.type ?? 'message'}</strong>{event.id && <span>ID {event.id}</span>}<time>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ''}</time></summary><JsonViewer value={event.data}/></details>)}</div> : <p className="muted">No previous events have been retained.</p> : <p className="muted">Loading previous events…</p>}</section>}
          <div className="editor-section-heading editor-current-heading"><h2>{gate.stage === 'event' ? 'Paused event' : `Paused ${gate.stage}`}</h2><span>Editable</span></div>
          <fieldset className="editor-fields form" disabled={busy || !pending}>
            {gate.stage === 'request' && <><label>URL<input value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })}/></label><label>Method<input value={draft.method} onChange={event => setDraft({ ...draft, method: event.target.value })}/></label></>}
            {gate.stage === 'response' && <label>Status code<input type="number" value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value })}/></label>}
            {gate.stage === 'event' && <label>Event type<input value={draft.event} onChange={event => setDraft({ ...draft, event: event.target.value })}/></label>}
            {gate.stage === 'response' && <div><button type="button" onClick={() => setBodyMode('raw')}>Raw body</button><button type="button" onClick={async () => { try { if (!decoded) { const result = await api(`/api/pending/${encodeURIComponent(gate.token)}/decode`, 'POST', {}) as DecodedBody; setDecoded(result); setDecodedText(result.body); } setBodyMode('decoded'); setError(''); } catch (e) { setError(errorMessage(e)); } }}>Decoded body</button>{decoded && <button type="button" onClick={() => { setDecoded(null); setDecodedText(''); setBodyMode('raw'); }}>Discard decoded view and edits</button>}{decoded && <p className="muted">{decoded.warning} {decodedText !== decoded.body ? 'Decoded changes will be re-encoded on Continue.' : ''}</p>}</div>}
            {bodyMode === 'decoded' && decoded ? <JsonBodyEditor label="Decoded response body" value={decodedText} disabled={!decoded.editable} onChange={setDecodedText} onReplacingChange={setReplacingBody}/> : <div className="editor-body-field"><span className="editor-body-heading"><span>{gate.stage === 'event' ? 'Event data' : 'Body'}</span><button type="button" disabled={Boolean(gate.value.bodyUnavailable) || replacingBody || Boolean(decoded)} onClick={() => { const formatted = prepareJson(draft.body); if (!formatted.isJson) { setError('This body is not valid JSON. Correct it before formatting.'); return; } setDraft({ ...draft, body: formatted.text }); setError(''); }}>Format JSON</button></span><JsonBodyEditor key={gate.token} label={gate.stage === 'event' ? 'Event data' : 'Body'} disabled={Boolean(gate.value.bodyUnavailable) || Boolean(decoded)} value={draft.body} onChange={body => setDraft({ ...draft, body })} onReplacingChange={setReplacingBody}/><small>{gate.value.bodyUnavailable ? gate.value.bodyUnavailableReason || 'Body is unavailable for editing.' : 'JSON is formatted for readability. Leaving it unchanged preserves its original bytes.'}</small></div>}
            {gate.stage !== 'event' && <details key={gate.token} className="headers-disclosure"><summary>Headers ({gate.value.headers?.length ?? 0})</summary><label className="editor-headers-field">Headers (JSON pairs)<textarea className="mono" rows={7} spellCheck={false} value={draft.headers} onChange={event => setDraft({ ...draft, headers: event.target.value })}/></label></details>}
          </fieldset>
          </section></div>
        </>}
      </> : seedLoading ? <p className="muted">Loading selected request…</p> : editing ? <fieldset className="editor-fields form" disabled={busy}>
        <label>Name<input value={editing.name ?? ''} onChange={event => setEditing({ ...editing, name: event.target.value })}/></label>
        <label>Folder<select value={editing.folderId ?? ''} onChange={event => { const { folderId: _folderId, ...rule } = editing; setEditing(event.target.value ? { ...rule, folderId: event.target.value } : rule); }}><option value="">Ungrouped</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
        <label>URL wildcard<input className="mono" maxLength={4096} value={editing.pattern} onChange={event => setEditing({ ...editing, pattern: event.target.value })}/><small>Use * for any characters. Example: *api.example.com/v1/*</small></label>
        <label>Method<input list="http-methods" value={editing.method} onChange={event => setEditing({ ...editing, method: event.target.value })}/><datalist id="http-methods">{['*','GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map(method => <option key={method} value={method}/>)}</datalist><small>Use * for any method.</small></label>
        <fieldset><legend>{mode === 'scripts' ? 'Run hooks at' : 'Pause at'}</legend>{['request','response','event'].map(stage => <label className="check" key={stage}><input type="checkbox" checked={editing.stages.includes(stage)} onChange={event => setEditing({ ...editing, stages: event.target.checked ? [...editing.stages, stage] : editing.stages.filter(value => value !== stage) })}/>{stage === 'event' ? 'Each SSE event' : stage === 'request' ? 'Request' : 'Response'}</label>)}</fieldset>
        <label className="check"><input type="checkbox" checked={editing.enabled} onChange={event => setEditing({ ...editing, enabled: event.target.checked })}/>Enabled</label>
        {mode === 'scripts' && <><p className="muted">Return the edited value from onRequest(context, url, request), onResponse(context, url, request, response), or onEvent(context, url, request, event).</p><label>JavaScript<textarea className="mono script-editor" spellCheck={false} maxLength={100000} value={editing.script ?? ''} onChange={event => setEditing({ ...editing, script: event.target.value })}/></label></>}
      </fieldset> : <><p className="muted">{mode === 'scripts' ? 'Run JavaScript hooks for matching traffic. Each rule has its own URL wildcard and stages.' : 'Pause matching requests, responses, or SSE events before they continue.'}</p>{data ? <fieldset className="editor-fields rule-browser" disabled={busy}>
        <aside className="rule-folder-sidebar">
          <div className="rule-folder-heading"><h2>Folders</h2><button className="icon-button" aria-label="New folder" title="New folder" onClick={() => { setFolderForm({ name: '' }); setConfirmDeleteFolder(false); setError(''); }}><Plus size={14}/></button></div>
          <nav className="rule-folder-nav" aria-label="Rule folders">
            {[{ id: 'all', name: 'All rules', count: rules.length }, { id: 'ungrouped', name: 'Ungrouped', count: rules.filter(rule => !rule.folderId).length }, ...folders.map(folder => ({ ...folder, count: rules.filter(rule => rule.folderId === folder.id).length }))].map(folder => <button key={folder.id} className={selectedFolder === folder.id ? 'selected' : ''} aria-label={folder.name} aria-current={selectedFolder === folder.id ? 'page' : undefined} onClick={() => { setSelectedFolder(folder.id); setFolderForm(null); setConfirmDeleteFolder(false); }}><Folder size={13}/><span title={folder.name}>{folder.name}</span><small>{folder.count}</small></button>)}
          </nav>
          {folderForm && <form className="rule-folder-form" onSubmit={event => { event.preventDefault(); void saveFolder(); }}><label htmlFor="folder-name">{folderForm.id ? 'Rename folder' : 'New folder'}</label><input id="folder-name" aria-label="Folder name" autoFocus maxLength={128} value={folderForm.name} onChange={event => setFolderForm({ ...folderForm, name: event.target.value })}/><div><button type="button" onClick={() => { setFolderForm(null); setError(''); }}>Cancel</button><button className="primary" type="submit" disabled={!folderForm.name.trim()}>{folderForm.id ? 'Save folder' : 'Create folder'}</button></div></form>}
        </aside>
        <section className="rule-folder-content" aria-label="Folder rules">
          <div className="rule-folder-title"><h2>{selectedFolder === 'all' ? 'All rules' : activeFolder?.name ?? 'Ungrouped'} <small>{visibleRules.length}</small></h2>{activeFolder && <div className="rule-folder-actions"><button onClick={() => { setFolderForm({ id: activeFolder.id, name: activeFolder.name }); setConfirmDeleteFolder(false); setError(''); }}>Rename folder</button><button onClick={() => { setConfirmDeleteFolder(true); setFolderForm(null); }}>Delete folder</button></div>}</div>
          {confirmDeleteFolder && activeFolder && <div className="rule-folder-confirm" role="group" aria-label="Delete folder?"><p>Delete “{activeFolder.name}”? Its rules will move to Ungrouped.</p><div><button onClick={() => setConfirmDeleteFolder(false)}>Cancel</button><button className="error-text" onClick={() => void deleteFolder()}>Keep rules and delete folder</button></div></div>}
          <RuleList rules={visibleRules} emptyMessage={selectedFolder !== 'all' ? 'No rules in this folder. Add a rule or move one here from its editor.' : mode === 'scripts' ? 'No JavaScript rules yet.' : 'No breakpoint rules yet.'} onToggle={(rule, enabled) => void mutateRules(rules => rules.map(item => item.id === rule.id ? { ...item, enabled } : item))} onEdit={rule => { setEditing(rule); setEditingRevision(data?.rulesRevision ?? null); setError(''); }} onDelete={rule => void mutateRules(rules => rules.filter(item => item.id !== rule.id))}/>
        </section>
      </fieldset> : <p className="muted">Connecting…</p>}</>}
    </div>
    <footer className="editor-window-footer">
      {mode === 'paused' ? <>{pending && <><button className="error-text" disabled={busy || replacingBody} onClick={() => void resolveGate('drop')}>Drop connection</button><button className="primary" aria-label="Continue" aria-keyshortcuts="Meta+Enter" disabled={busy || replacingBody} onClick={() => void resolveGate('continue')}>Continue <span aria-hidden="true">⌘↵</span></button></>}<button onClick={() => window.close()}>Close</button></> : editing ? <><button disabled={busy} onClick={() => { setEditing(null); setError(''); }}>Cancel</button><button className="primary" disabled={busy} onClick={() => void saveRule()}>Save rule</button></> : <><button onClick={() => window.close()}>Close</button><button className="primary" disabled={busy || !data || seedLoading} onClick={() => { setEditing({ ...newRule(), ...(activeFolder ? { folderId: activeFolder.id } : {}) }); setFolderForm(null); setConfirmDeleteFolder(false); setError(''); }}><Plus size={14}/>Add rule</button></>}
    </footer>
  </main>;
}
