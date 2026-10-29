import { WifiOff, ArrowDownToLine, Code2, Command, HelpCircle, ListFilter, Moon, Pause, Play, Search, Settings, Sun, Toolbox, Trash2 } from 'lucide-react';
import streamglassLogo from './assets/streamglass.svg';
import './toolbar.css';

export type CaptureStatus = 'recording' | 'paused' | 'stopped' | 'disconnected';

type Props = {
  status: CaptureStatus;
  address: string;
  offline?: boolean;
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

const statusText: Record<CaptureStatus, string> = { recording: 'Recording', paused: 'Paused', stopped: 'Stopped', disconnected: 'Disconnected' };

// Icon buttons reveal a short text label on hover or keyboard focus; the accessible name stays the full label.
function ToolButton({ label, text, onClick, active, disabled, children, shortcut }: { label: string; text: string; onClick: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode; shortcut?: string }) {
  return <button type="button" className={`tool-button${active ? ' active' : ''}`} aria-label={label} title={shortcut ? `${label} (${shortcut})` : undefined} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}<span className="tool-label" aria-hidden="true">{text}</span></button>;
}

// Proxyman-style header: capture controls on the left, a status capsule in the middle that always says what the
// proxy is doing and where, and windows/settings on the right. It doubles as the macOS title bar.
export default function Toolbar(p: Props) {
  const playing = p.status === 'recording';
  return <header className="toolbar">
    <div className="toolbar-group">
      <button type="button" className={`capture-button${playing ? ' playing' : ''}`} disabled={p.busy || p.status === 'disconnected'} onClick={p.onToggleCapture}
        aria-label={p.status === 'stopped' ? 'Start capture and rules' : playing ? 'Pause capture and rules' : 'Resume capture and rules'}
        title={'\u2318\u21e7P'}>
        {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}<span className="tool-label" aria-hidden="true">{p.status === 'stopped' ? 'Start' : playing ? 'Pause' : 'Resume'}</span>
      </button>
      <div className="tool-capsule">
        <ToolButton label="Export all captures" text="Export" onClick={p.onExportAll} disabled={p.busy || !p.hasRecords}><ArrowDownToLine /></ToolButton>
        <ToolButton label="Delete all records" text="Clear" onClick={p.onDeleteAll} disabled={p.busy || !p.hasRecords}><Trash2 /></ToolButton>
      </div>
    </div>
    <div className={`status-capsule status-${p.status}`} role="status" aria-label={`Streamglass, ${statusText[p.status]}${p.address ? `, listening on ${p.address}` : ''}${p.offline ? ', no network' : ''}`}>
      <i className="status-dot" aria-hidden="true" />
      <img className="brand-logo" src={streamglassLogo} alt="Streamglass logo" />
      <strong>Streamglass</strong>
      {p.address && <><span className="status-sep" aria-hidden="true">|</span><span className="status-address" title="Proxy address"><b>{p.address}</b></span></>}
      <span className="status-sep" aria-hidden="true">|</span>
      <button type="button" className="status-state" disabled={p.busy || p.status === 'disconnected'} onClick={p.onToggleCapture}>{statusText[p.status]}</button>
      <span className="status-badges">
        {p.offline && <span className="status-badge warn" role="status" title="This Mac has no Wi-Fi or Ethernet connection. Phones can't reach the proxy; apps on this Mac still use 127.0.0.1."><WifiOff size={12} aria-hidden="true" />No network</span>}
        {p.pausedCount > 0 && <button type="button" className="status-badge warn" onClick={p.onBreakpoints}>{p.pausedCount} paused</button>}
        {p.filterActive && <button type="button" className="status-badge accent" onClick={p.onToggleFilter} title="A filter is hiding some requests">Filtered</button>}
      </span>
    </div>
    <div className="toolbar-group">
      <div className="tool-capsule">
        <ToolButton label="Filter requests" text="Filter" shortcut="⌘F" active={p.filterOpen || p.filterActive} onClick={p.onToggleFilter}><Search />{p.filterActive && <i className="tool-dot" aria-hidden="true" />}</ToolButton>
        <ToolButton label="Command palette" text="Commands" shortcut="⌘K" onClick={p.onPalette}><Command /></ToolButton>
      </div>
      <div className="tool-capsule">
        <ToolButton label="Breakpoint rules" text="Breakpoints" onClick={p.onBreakpoints}><ListFilter /></ToolButton>
        <ToolButton label="JavaScript hooks" text="Scripts" onClick={p.onScripts}><Code2 /></ToolButton>
        <ToolButton label="Tools" text="Tools" onClick={p.onTools}><Toolbox /></ToolButton>
      </div>
      <div className="tool-capsule">
        <ToolButton label="Settings" text="Settings" onClick={p.onSettings}><Settings /></ToolButton>
        <ToolButton label="Welcome tour" text="Tour" onClick={p.onHelp}><HelpCircle /></ToolButton>
        <ToolButton label={`Use ${p.theme === 'dark' ? 'light' : 'dark'} theme`} text={p.theme === 'dark' ? 'Light' : 'Dark'} onClick={p.onTheme}>{p.theme === 'dark' ? <Sun /> : <Moon />}</ToolButton>
      </div>
    </div>
  </header>;
}
