import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import './McpSettings.css';

type McpConnection = { running: boolean; url: string; token: string; error?: string; approvedRedirects?: string[] };
type McpBridge = { forgetMcpRedirect?(target: string): Promise<McpConnection> };

export default function McpSettings() {
  const [connection, setConnection] = useState<McpConnection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  async function refresh() {
    try {
      const result = await window.streamglass?.getMcpConnection();
      if (!result) throw new Error('Desktop app only.');
      setConnection(result);
      setError(result.error ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function toggle() {
    if (!connection) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.streamglass?.setMcpEnabled(!connection.running);
      if (!result) throw new Error('Unavailable.');
      setConnection(result);
      setError(result.error ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function forget(target: string) {
    try {
      const result = await (window.streamglass as McpBridge | undefined)?.forgetMcpRedirect?.(target);
      if (result) setConnection(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function copy(label: string, config: object) {
    try {
      const text = JSON.stringify(config, null, 2);
      if (window.streamglass?.copyText) await window.streamglass.copyText(text);
      else await navigator.clipboard.writeText(text);
      setCopied(`${label} copied.`);
    } catch {
      setCopied('Could not copy.');
    }
  }

  const httpConfig = connection && { mcpServers: { streamglass: { type: 'http', url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } } } };

  return <section className="mcp-settings" aria-labelledby="mcp-settings-title">
    <div className="setting-summary"><span className={`mcp-indicator ${connection?.running ? 'running' : ''}`} aria-hidden="true"/><div><strong id="mcp-settings-title">AI agent MCP</strong><p>{connection ? connection.running ? 'Running' : 'Stopped' : 'Checking…'}</p></div></div>
    <p className="muted mcp-warn" title="Off until enabled; runs only while the app is open. Streamglass asks before an agent sends requests, redirects traffic, unlocks HTTPS sites, runs new JavaScript or loads a workspace."><TriangleAlert size={14} aria-hidden="true"/>Agents can read captured requests, cookies and tokens, and may send them to their provider.</p>
    <button type="button" disabled={!connection || busy} onClick={() => void toggle()}>{busy ? 'Updating…' : connection?.running ? 'Disable MCP server' : 'Enable MCP server'}</button>
    {connection && <div className="mcp-details">
      <label>URL<input className="mono" readOnly value={connection.url} onFocus={e => e.currentTarget.select()}/></label>
      <label>Bearer token<input className="mono" type="password" readOnly value={connection.token} aria-label="Bearer token (masked)"/></label>
      <div className="mcp-copy-actions">
        <button type="button" onClick={() => httpConfig && void copy('HTTP', httpConfig)}>Copy config</button>
      </div>
    </div>}
    {connection && <div className="mcp-approved">
      <strong title="Servers you allowed an agent to redirect traffic to. Removing one makes the agent ask again.">Approved redirects</strong>
      {connection.approvedRedirects?.length ? <ul>{connection.approvedRedirects.map(target => <li key={target}><code>{target}</code><button type="button" onClick={() => void forget(target)}>Remove</button></li>)}</ul>
        : <p className="muted">None</p>}
    </div>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <p className="mcp-feedback" role="status" aria-live="polite">{copied}</p>
  </section>;
}
