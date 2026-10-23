import { ArrowDownToLine, Code2, Command, HelpCircle, ListFilter, Moon, Pause, Play, Search, Settings2, Sun, Trash2, Wrench } from 'lucide-react';
import streamglassLogo from './assets/streamglass.svg';
import './toolbar.css';

export type CaptureStatus = 'recording' | 'paused' | 'stopped' | 'disconnected';

type Props = {
  status: CaptureStatus;
  address: string;
  pausedCount: number;
  filterActive: boolean;
  filterOpen: boolean;
  busy: boolean;
  hasRecords: boolean;
  theme: string;
  onToggleCapture: () => void;
  onExportAll: () => void;
  onDeleteAll: () => void;
  onToggleFilter: () => void;
  onPalette: () => void;
  onBreakpoints: () => void;
  onScripts: () => void;
  onTools: () => void;
  onSettings: () => void;
  onHelp: () => void;
  onTheme: () => void;
};

const statusText: Record<CaptureStatus, string> = { recording: 'Recording', paused: 'Paused · rules bypassed', stopped: 'Proxy stopped', disconnected: 'Disconnected' };

function ToolButton({ label, onClick, active, disabled, children, shortcut }: { label: string; onClick: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode; shortcut?: string }) {
  return <button type="button" className={`tool-button${active ? ' active' : ''}`} aria-label={label} title={shortcut ? `${label} (${shortcut})` : label} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}

// Proxyman-style header: capture controls on the left, a status capsule in the middle that always says what the
// proxy is doing and where, and windows/settings on the right. It doubles as the macOS title bar.
export default function Toolbar(p: Props) {
  const playing = p.status === 'recording';
  return <header className="toolbar">
    <div className="toolbar-group">
      <button type="button" className={`capture-button${playing ? ' playing' : ''}`} disabled={p.busy || p.status === 'disconnected'} onClick={p.onToggleCapture}
        aria-label={p.status === 'stopped' ? 'Start capture and rules' : playing ? 'Pause capture and rules' : 'Resume capture and rules'}
        title={p.status === 'stopped' ? 'Start capture and rules' : playing ? 'Pause capture and rules' : 'Resume capture and rules'}>
        {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
      </button>
      <div className="tool-capsule">
        <ToolButton label="Export all captures" onClick={p.onExportAll} disabled={p.busy || !p.hasRecords}><ArrowDownToLine /></ToolButton>
        <ToolButton label="Delete all records" onClick={p.onDeleteAll} disabled={p.busy || !p.hasRecords}><Trash2 /></ToolButton>
      </div>
    </div>
    <div className={`status-capsule status-${p.status}`} role="status" aria-label={`Streamglass, ${statusText[p.status]}${p.address ? `, listening on ${p.address}` : ''}`}>
      <i className="status-dot" aria-hidden="true" />
      <img className="brand-logo" src={streamglassLogo} alt="Streamglass logo" />
      <strong>Streamglass</strong>
      {p.address && <><span className="status-sep" aria-hidden="true">|</span><span className="status-address">Listening on <b>{p.address}</b></span></>}
      <span className="status-sep" aria-hidden="true">|</span>
      <button type="button" className="status-state" disabled={p.busy || p.status === 'disconnected'} onClick={p.onToggleCapture}>{statusText[p.status]}</button>
      <span className="status-badges">
        {p.pausedCount > 0 && <button type="button" className="status-badge warn" onClick={p.onBreakpoints}>{p.pausedCount} paused</button>}
        {p.filterActive && <button type="button" className="status-badge accent" onClick={p.onToggleFilter} title="A filter is hiding some requests">Filtered</button>}
      </span>
    </div>
    <div className="toolbar-group">
      <div className="tool-capsule">
        <ToolButton label="Filter requests" shortcut="⌘F" active={p.filterOpen || p.filterActive} onClick={p.onToggleFilter}><Search />{p.filterActive && <i className="tool-dot" aria-hidden="true" />}</ToolButton>
        <ToolButton label="Command palette" shortcut="⌘K" onClick={p.onPalette}><Command /></ToolButton>
      </div>
      <div className="tool-capsule">
        <ToolButton label="Breakpoint rules" onClick={p.onBreakpoints}><ListFilter /></ToolButton>
        <ToolButton label="JavaScript hooks" onClick={p.onScripts}><Code2 /></ToolButton>
        <ToolButton label="Tools" onClick={p.onTools}><Wrench /></ToolButton>
      </div>
      <div className="tool-capsule">
        <ToolButton label="Settings" onClick={p.onSettings}><Settings2 /></ToolButton>
        <ToolButton label="Welcome tour" onClick={p.onHelp}><HelpCircle /></ToolButton>
        <ToolButton label={`Use ${p.theme === 'dark' ? 'light' : 'dark'} theme`} onClick={p.onTheme}>{p.theme === 'dark' ? <Sun /> : <Moon />}</ToolButton>
      </div>
    </div>
  </header>;
}
