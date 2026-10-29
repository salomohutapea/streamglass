import { useCallback, useEffect, useRef, useState } from 'react';
import { Folder, Globe, Pencil, Plus, Trash2 } from 'lucide-react';
import RuleList, { PopupMenu, ruleDragType } from './RuleList';
import { upsertRule } from './rule-order.mjs';
import './editor-window.css';

type Rule = { id: string; name?: string; enabled: boolean; pattern: string; method: string; stages: string[]; script?: string; breakpoint?: boolean; folderId?: string };
type RuleFolder = { id: string; name: string; kind: 'breakpoints' | 'scripts' };
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
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const newRule = (): Rule => ({ id: crypto.randomUUID(), name: '', enabled: true, pattern: '*', method: '*', stages: ['request'], breakpoint: mode !== 'scripts', ...(mode === 'scripts' ? { script: scriptTemplate } : {}) });

export default function EditorWindow() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [data, setData] = useState<State | null>(null);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const [selectedFolder, setSelectedFolder] = useState('all');
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [folderForm, setFolderForm] = useState<{ id?: string; name: string } | null>(null);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState(false);
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number } | null>(null);
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
  async function moveRule(rule: Rule, folderId: string | null) {
    await mutateRules(rules => rules.map(item => { if (item.id !== rule.id) return item; const { folderId: _old, ...rest } = item; return folderId ? { ...rest, folderId } : rest; }));
  }
  async function createFolderAndMove(rule: Rule, name: string) {
    if (working.current) return;
    setError('');
    let folder: RuleFolder;
    try { folder = await api('/api/folders', 'POST', { name, kind }) as RuleFolder; }
    catch (error) { setError(errorMessage(error)); return; }
    if (await mutateRules(rules => rules.map(item => item.id === rule.id ? { ...item, folderId: folder.id } : item))) setSelectedFolder(folder.id);
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
  return <main className="editor-window">
    <header className="editor-window-heading window-header"><h1>{title}</h1><span role="img" aria-label="Applies to all connected devices" title="Applies to all connected devices"><Globe size={14}/></span></header>
    {error && <div className="editor-error" role="alert"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
    <div className={`editor-window-content${!editing && !seedLoading ? ' is-browser' : ''}`}>
      {seedLoading ? <p className="muted">Loading…</p> : editing ? <fieldset className="editor-fields form" disabled={busy}>
        <label>Name<input value={editing.name ?? ''} onChange={event => setEditing({ ...editing, name: event.target.value })}/></label>
        <label>Folder<select value={editing.folderId ?? ''} onChange={event => { const { folderId: _folderId, ...rule } = editing; setEditing(event.target.value ? { ...rule, folderId: event.target.value } : rule); }}><option value="">Ungrouped</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
        <label>URL wildcard<input className="mono" maxLength={4096} placeholder="*api.example.com/v1/*" title="* matches any characters" value={editing.pattern} onChange={event => setEditing({ ...editing, pattern: event.target.value })}/></label>
        <label>Method<input list="http-methods" placeholder="*" title="* matches any method" value={editing.method} onChange={event => setEditing({ ...editing, method: event.target.value })}/><datalist id="http-methods">{['*','GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map(method => <option key={method} value={method}/>)}</datalist></label>
        <fieldset><legend>{mode === 'scripts' ? 'Run hooks at' : 'Pause at'}</legend>{['request','response','event'].map(stage => <label className="check" key={stage}><input type="checkbox" checked={editing.stages.includes(stage)} onChange={event => setEditing({ ...editing, stages: event.target.checked ? [...editing.stages, stage] : editing.stages.filter(value => value !== stage) })}/>{stage === 'event' ? 'Each SSE event' : stage === 'request' ? 'Request' : 'Response'}</label>)}</fieldset>
        <label className="check"><input type="checkbox" checked={editing.enabled} onChange={event => setEditing({ ...editing, enabled: event.target.checked })}/>Enabled</label>
        {mode === 'scripts' && <><label>JavaScript<textarea className="mono script-editor" spellCheck={false} maxLength={100000} value={editing.script ?? ''} onChange={event => setEditing({ ...editing, script: event.target.value })}/></label></>}
      </fieldset> : <>{data ? <fieldset className="editor-fields rule-browser" disabled={busy}>
        <aside className="rule-folder-sidebar" onContextMenu={event => { event.preventDefault(); setFolderMenu({ x: event.clientX, y: event.clientY }); }}>
          <div className="rule-folder-heading"><h2>Folders</h2><button className="icon-button" aria-label="New folder" title="New folder" onClick={() => { setFolderForm({ name: '' }); setConfirmDeleteFolder(false); setError(''); }}><Plus size={14}/></button></div>
          <nav className="rule-folder-nav" aria-label="Rule folders">
            {[{ id: 'all', name: 'All rules', count: rules.length }, { id: 'ungrouped', name: 'Ungrouped', count: rules.filter(rule => !rule.folderId).length }, ...folders.map(folder => ({ ...folder, count: rules.filter(rule => rule.folderId === folder.id).length }))].map(folder => <button key={folder.id} className={`${selectedFolder === folder.id ? 'selected' : ''}${dropFolder === folder.id ? ' drop-target' : ''}`} {...(folder.id !== 'all' ? { onDragOver: (event: import('react').DragEvent) => { if (event.dataTransfer.types.includes(ruleDragType)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropFolder(folder.id); } }, onDragLeave: () => setDropFolder(current => current === folder.id ? null : current), onDrop: (event: import('react').DragEvent) => { event.preventDefault(); setDropFolder(null); const rule = rules.find(item => item.id === event.dataTransfer.getData(ruleDragType)); if (rule) void moveRule(rule, folder.id === 'ungrouped' ? null : folder.id); } } : {})} aria-label={folder.name} aria-current={selectedFolder === folder.id ? 'page' : undefined} onClick={() => { setSelectedFolder(folder.id); setFolderForm(null); setConfirmDeleteFolder(false); }}><Folder size={13}/><span title={folder.name}>{folder.name}</span><small>{folder.count}</small></button>)}
          </nav>
          {folderMenu && <PopupMenu x={folderMenu.x} y={folderMenu.y} label="Folder actions" opener={null} onClose={() => setFolderMenu(null)}><button role="menuitem" onClick={() => { setFolderMenu(null); setFolderForm({ name: '' }); setConfirmDeleteFolder(false); setError(''); }}><Plus size={13}/>New folder…</button></PopupMenu>}
          {folderForm && <form className="rule-folder-form" onSubmit={event => { event.preventDefault(); void saveFolder(); }}><input id="folder-name" aria-label="Folder name" placeholder="Folder name" autoFocus maxLength={128} value={folderForm.name} onChange={event => setFolderForm({ ...folderForm, name: event.target.value })}/><div><button type="button" onClick={() => { setFolderForm(null); setError(''); }}>Cancel</button><button className="primary" type="submit" disabled={!folderForm.name.trim()}>{folderForm.id ? 'Save folder' : 'Create folder'}</button></div></form>}
        </aside>
        <section className="rule-folder-content" aria-label="Folder rules">
          <div className="rule-folder-title"><h2>{selectedFolder === 'all' ? 'All rules' : activeFolder?.name ?? 'Ungrouped'} <small>{visibleRules.length}</small></h2>{activeFolder && <div className="rule-folder-actions"><button className="icon-button" aria-label="Rename folder" title="Rename folder" onClick={() => { setFolderForm({ id: activeFolder.id, name: activeFolder.name }); setConfirmDeleteFolder(false); setError(''); }}><Pencil size={13}/></button><button className="icon-button" aria-label="Delete folder" title="Delete folder" onClick={() => { setConfirmDeleteFolder(true); setFolderForm(null); }}><Trash2 size={13}/></button></div>}</div>
          {confirmDeleteFolder && activeFolder && <div className="rule-folder-confirm" role="group" aria-label="Delete folder?"><p>Delete “{activeFolder.name}”? Rules move to Ungrouped.</p><div><button onClick={() => setConfirmDeleteFolder(false)}>Cancel</button><button className="error-text" aria-label="Keep rules and delete folder" onClick={() => void deleteFolder()}>Delete folder</button></div></div>}
          <RuleList rules={visibleRules} folders={folders} onMove={(rule, folderId) => void moveRule(rule, folderId)} onCreateFolderAndMove={(rule, name) => void createFolderAndMove(rule, name)} emptyMessage={selectedFolder !== 'all' ? 'Folder is empty' : mode === 'scripts' ? 'No scripts yet' : 'No breakpoints yet'} onToggle={(rule, enabled) => void mutateRules(rules => rules.map(item => item.id === rule.id ? { ...item, enabled } : item))} onEdit={rule => { setEditing(rule); setEditingRevision(data?.rulesRevision ?? null); setError(''); }} onDelete={rule => void mutateRules(rules => rules.filter(item => item.id !== rule.id))}/>
        </section>
      </fieldset> : <p className="muted">Connecting…</p>}</>}
    </div>
    <footer className="editor-window-footer">
      {editing ? <><button disabled={busy} onClick={() => { if (recordId) { window.close(); return; } setEditing(null); setError(''); }}>Cancel</button><button className="primary" disabled={busy} onClick={() => void saveRule()}>Save rule</button></> : <><button onClick={() => window.close()}>Close</button><button className="primary" disabled={busy || !data || seedLoading} onClick={() => { setEditing({ ...newRule(), ...(activeFolder ? { folderId: activeFolder.id } : {}) }); setFolderForm(null); setConfirmDeleteFolder(false); setError(''); }}><Plus size={14}/>Add rule</button></>}
    </footer>
  </main>;
}
