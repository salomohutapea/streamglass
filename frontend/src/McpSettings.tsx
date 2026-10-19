import { useEffect, useState } from 'react';
import './McpSettings.css';

type McpConnection = { running: boolean; url: string; sseUrl: string; token: string; error?: string };

export default function McpSettings() {
  const [connection, setConnection] = useState<McpConnection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  async function refresh() {
    try {
      const result = await window.streamglass?.getMcpConnection();
      if (!result) throw new Error('MCP settings are available in the Streamglass desktop app.');
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
      if (!result) throw new Error('MCP settings are unavailable.');
      setConnection(result);
      setError(result.error ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(label: string, config: object) {
    try {
      const text = JSON.stringify(config, null, 2);
      if (window.streamglass?.copyText) await window.streamglass.copyText(text);
      else await navigator.clipboard.writeText(text);
      setCopied(`${label} configuration copied.`);
    } catch {
      setCopied('Could not copy configuration. Check clipboard access and try again.');
    }
  }

  const sseConfig = connection && { mcpServers: { streamglass: { type: 'sse', url: connection.sseUrl, headers: { Authorization: `Bearer ${connection.token}` } } } };
  const httpConfig = connection && { mcpServers: { streamglass: { type: 'http', url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } } } };

  return <section className="mcp-settings" aria-labelledby="mcp-settings-title">
    <div className="setting-summary"><span className={`mcp-indicator ${connection?.running ? 'running' : ''}`} aria-hidden="true"/><div><strong id="mcp-settings-title">AI agent MCP</strong><p>{connection ? connection.running ? 'Local MCP server is running.' : 'Local MCP server is stopped.' : 'Checking local MCP server…'}</p></div></div>
    <p className="muted">Connect an AI agent to inspect Streamglass traffic. The server supports live <code>watch_sse_events</code> notifications and runs only while the app is open.</p>
    <button type="button" disabled={!connection || busy} onClick={() => void toggle()}>{busy ? 'Updating…' : connection?.running ? 'Disable MCP server' : 'Enable MCP server'}</button>
    {connection && <div className="mcp-details">
      <label>HTTP URL<input className="mono" readOnly value={connection.url} onFocus={e => e.currentTarget.select()}/></label>
      <label>SSE URL<input className="mono" readOnly value={connection.sseUrl} onFocus={e => e.currentTarget.select()}/></label>
      <label>Bearer token<input className="mono" type="password" readOnly value={connection.token} aria-label="Bearer token (masked)"/></label>
      <div className="mcp-copy-actions">
        <button type="button" onClick={() => sseConfig && void copy('SSE', sseConfig)}>Copy SSE configuration</button>
        <button type="button" onClick={() => httpConfig && void copy('HTTP', httpConfig)}>Copy HTTP configuration</button>
      </div>
    </div>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <p className="mcp-feedback" role="status" aria-live="polite">{copied}</p>
  </section>;
}
