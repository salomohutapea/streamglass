import { useCallback, useEffect, useRef, useState } from 'react';
import Banner from './Banner';
import { FolderPlus, Globe, Plus } from 'lucide-react';
import ListSearch from './ListSearch';
import {matchesRuleSearch} from './list-search.mjs';
import RuleTable from './RuleTable';
import { dropPlacement, folderPath, ruleRows, stepPlacement, type TreeRef } from './rule-tree.mjs';
import { confirmAction } from './confirm-dialog';
import ScriptEditor from './ScriptEditor';
import { upsertRule } from './rule-order.mjs';
import './editor-window.css';

type Rule = { id: string; name?: string; enabled: boolean; pattern: string; method: string; stages: string[]; script?: string; breakpoint?: boolean; folderId?: string; order?: number };
type RuleFolder = { id: string; name: string; kind: 'breakpoints' | 'scripts'; parentId?: string; enabled?: boolean; expanded?: boolean; order?: number };
type State = { rules: Rule[]; rulesRevision: number; folders: RuleFolder[] };
type Connection = { baseUrl: string; token: string };
const params = new URLSearchParams(location.search);
const mode = params.get('editor');
const recordId = params.get('record');
const scriptTemplate = `async function onRequest(context, url, request) {
  return request;
}

async function onResponse(context, url, request, response) {
  return response;
}

async function onEvent(context, url, request, event) {
  return event;
}`;
const scriptLimit = 100000;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const newRule = (): Rule => ({ id: crypto.randomUUID(), name: '', enabled: true, pattern: '*', method: '*', stages: ['request'], breakpoint: mode !== 'scripts', ...(mode === 'scripts' ? { script: scriptTemplate } : {}) });

export default function EditorWindow() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [data, setData] = useState<State | null>(null);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [folderForm, setFolderForm] = useState<{ id?: string; parentId?: string | null; name: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [seedLoading, setSeedLoading] = useState(Boolean(recordId));
  const revision = useRef(0);
  const working = useRef(false);
  // Opened from a captured request: show only this rule's form and close when done, never the rules list.
  const title = recordId ? (mode === 'scripts' ? 'New JavaScript rule' : 'New breakpoint') : mode === 'scripts' ? 'JavaScript rules' : 'Breakpoint rules';
  const kind = mode === 'scripts' ? 'scripts' : 'breakpoints';
  const folders = data?.folders?.filter(folder => folder.kind === kind) ?? [];
  const rules = data?.rules.filter(rule => mode === 'scripts' ? rule.breakpoint === false : rule.breakpoint !== false) ?? [];
  const searching = Boolean(query.trim());
  const rows = ruleRows(rules, folders, searching ? rule => matchesRuleSearch(rule, query, folders) : undefined);
  const shownRules = rows.filter(row => row.type === 'rule').length;

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
        }
      } catch (error) { if (active && current === revision.current) setError(errorMessage(error)); }
      finally { if (active) timer = setTimeout(refresh, 1000); }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [connection, api]);

  useEffect(() => {
    if (!connection || !recordId) return;
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
    if (await mutateRules(rules => upsertRule(rules, editing), editingRevision)) { if (recordId) { window.close(); return; } setEditing(null); setEditingRevision(null); }
  }
  // Folder writes go through the folder route; the engine re-sorts the stored rules to match the tree in the same write.
  async function folderRequest(run: () => Promise<unknown>) {
    if (working.current) return false;
    working.current = true; revision.current++; setBusy(true); setError('');
    try { await run(); setData(await api('/api/state') as State); return true; }
    catch (error) { setError(errorMessage(error)); return false; }
    finally { revision.current++; working.current = false; setBusy(false); }
  }
  const patchFolder = (id: string, body: Record<string, unknown>) => folderRequest(() => api(`/api/folders/${encodeURIComponent(id)}`, 'PATCH', body));
  async function applyPlacement(item: TreeRef, place: { parentId: string | null; order: number } | null) {
    if (!place) return;
    if (item.type === 'folder') { await patchFolder(item.id, { parentId: place.parentId, order: place.order }); return; }
    await mutateRules(list => list.map(rule => { if (rule.id !== item.id) return rule; const { folderId: _old, ...rest } = rule; return { ...rest, order: place.order, ...(place.parentId ? { folderId: place.parentId } : {}) }; }));
  }
  function place(dragged: TreeRef, target: TreeRef, zone: 'before' | 'after' | 'inside') {
    // An empty target id means the top level (from the Move to menu): append after the last top-level item.
    if (target.type === 'folder' && !target.id) { const top = ruleRows(rules, folders.map(folder => ({ ...folder, expanded: false }))); void applyPlacement(dragged, { parentId: null, order: (top.at(-1)?.order ?? 0) + 1 }); return; }
    void applyPlacement(dragged, dropPlacement(rules, folders, dragged, target, zone));
  }
  async function saveFolder() {
    if (!folderForm) return;
    const name = folderForm.name.trim();
    if (!name) { setError('Enter a folder name.'); return; }
    const done = folderForm.id ? await patchFolder(folderForm.id, { name }) : await folderRequest(() => api('/api/folders', 'POST', { name, kind, ...(folderForm.parentId ? { parentId: folderForm.parentId } : {}) }));
    if (done) setFolderForm(null);
  }
  async function deleteFolder(folder: RuleFolder) {
    if (!await confirmAction({ title: `Delete the folder ${folder.name}?`, message: 'Its rules and folders move up one level. Nothing inside is deleted.', confirmLabel: 'Delete folder', danger: true })) return;
    await folderRequest(() => api(`/api/folders/${encodeURIComponent(folder.id)}`, 'DELETE'));
  }
  function expandFolder(folder: RuleFolder, expanded: boolean) {
    // Shown at once; the saved state follows.
    setData(current => current && { ...current, folders: current.folders.map(item => item.id === folder.id ? { ...item, expanded } : item) });
    void patchFolder(folder.id, { expanded });
  }
  return <main className="editor-window">
    <header className="editor-window-heading window-header"><h1>{title}</h1><span role="img" aria-label="Applies to all connected devices" title="Applies to all connected devices"><Globe size={14}/></span></header>
    {error && <Banner tone="error" className="editor-error" actions={<button onClick={() => setError('')}>Dismiss</button>}>{error}</Banner>}
    <div className={`editor-window-content${!editing && !seedLoading ? ' is-browser' : ''}`}>
      {seedLoading ? <p className="muted">Loading…</p> : editing ? <fieldset className="editor-fields form" disabled={busy}>
        <label>Name<input value={editing.name ?? ''} onChange={event => setEditing({ ...editing, name: event.target.value })}/></label>
        <label>Folder<select value={editing.folderId ?? ''} onChange={event => { const { folderId: _folderId, ...rule } = editing; setEditing(event.target.value ? { ...rule, folderId: event.target.value } : rule); }}><option value="">Top level</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folderPath(folders, folder.id)}</option>)}</select></label>
        <label>URL wildcard<input className="mono" maxLength={4096} placeholder="*api.example.com/v1/*" title="* matches any characters" value={editing.pattern} onChange={event => setEditing({ ...editing, pattern: event.target.value })}/></label>
        <label>Method<input list="http-methods" placeholder="*" title="* matches any method" value={editing.method} onChange={event => setEditing({ ...editing, method: event.target.value })}/><datalist id="http-methods">{['*','GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map(method => <option key={method} value={method}/>)}</datalist></label>
        <fieldset><legend>{mode === 'scripts' ? 'Run hooks at' : 'Pause at'}</legend>{['request','response','event'].map(stage => <label className="check" key={stage}><input type="checkbox" checked={editing.stages.includes(stage)} onChange={event => setEditing({ ...editing, stages: event.target.checked ? [...editing.stages, stage] : editing.stages.filter(value => value !== stage) })}/>{stage === 'event' ? 'Each SSE event' : stage === 'request' ? 'Request' : 'Response'}</label>)}</fieldset>
        <label className="check"><input type="checkbox" checked={editing.enabled} onChange={event => setEditing({ ...editing, enabled: event.target.checked })}/>Enabled</label>
        {mode === 'scripts' && <div className="editor-body-field"><span className="editor-body-heading"><span>JavaScript</span></span><ScriptEditor label="JavaScript" disabled={busy} value={editing.script ?? ''} onChange={script => setEditing(current => current && { ...current, script })}/>{(editing.script ?? '').length > scriptLimit && <small className="error-text">Script is {(editing.script ?? '').length.toLocaleString()} characters; the limit is {scriptLimit.toLocaleString()}.</small>}</div>}
      </fieldset> : <>{data ? <fieldset className="editor-fields rule-browser" disabled={busy}>
        <section className="rule-folder-content" aria-label="Rules">
          <div className="rule-table-toolbar"><ListSearch label={mode === 'scripts' ? 'Search scripts' : 'Search breakpoints'} placeholder={mode === 'scripts' ? 'Search name, URL, method or script…' : 'Search name, URL, method or stage…'} value={query} onChange={setQuery} matches={shownRules} total={rules.length}/><button type="button" aria-label="New folder" title="New folder" onClick={() => { setFolderForm({ parentId: null, name: '' }); setError(''); }}><FolderPlus size={14}/>New folder</button></div>
          <RuleTable rows={rows as any} folders={folders} searching={searching} folderForm={folderForm} onFolderForm={setFolderForm} onSaveFolder={() => void saveFolder()}
            emptyMessage={searching ? 'No matching rules. Clear search to show the list.' : mode === 'scripts' ? 'No scripts yet' : 'No breakpoints yet'}
            onToggleRule={(rule, enabled) => void mutateRules(list => list.map(item => item.id === rule.id ? { ...item, enabled } : item))}
            onToggleFolder={(folder, enabled) => void patchFolder(folder.id, { enabled })}
            onExpand={(folder, expanded) => expandFolder(folder as RuleFolder, expanded)}
            onEdit={rule => { setEditing(rule as Rule); setEditingRevision(data?.rulesRevision ?? null); setError(''); }}
            onDeleteRule={rule => void mutateRules(list => list.filter(item => item.id !== rule.id))}
            onDeleteFolder={folder => void deleteFolder(folder as RuleFolder)}
            onAddRule={folderId => { setEditing({ ...newRule(), ...(folderId ? { folderId } : {}) }); setFolderForm(null); setError(''); }}
            onPlace={place} onStep={(item, direction) => void applyPlacement(item, stepPlacement(rules, folders, item, direction))}/>
        </section>
      </fieldset> : <p className="muted">Connecting…</p>}</>}
    </div>
    <footer className="editor-window-footer">
      {editing ? <><button disabled={busy} onClick={() => { if (recordId) { window.close(); return; } setEditing(null); setError(''); }}>Cancel</button><button className="primary" disabled={busy} onClick={() => void saveRule()}>Save rule</button></> : <><button onClick={() => window.close()}>Close</button><button className="primary" disabled={busy || !data || seedLoading} onClick={() => { setEditing(newRule()); setFolderForm(null); setError(''); }}><Plus size={14}/>Add rule</button></>}
    </footer>
  </main>;
}
