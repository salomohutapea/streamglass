import { useEffect, useLayoutEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import type { ComparisonResult } from './capture-compare';
import { ensureMonaco, MONO_FONT, PLAIN_JSON } from './monaco-setup';
import './capture-diff.css';

// Above this size the diff keeps JSON colours but drops the JSON language services (validation, folding, symbols),
// which block the window for seconds on documents of several MiB.
const HIGHLIGHT_LIMIT = 2 * 1024 * 1024;

// VS Code's side-by-side diff over both captures as pretty JSON: removed text is red on A, added text green on B,
// and long identical stretches fold away. The changed-path list stays available below for exact values.
export default function CaptureDiff({ result, pending, error, labels = ['A', 'B'] }: { result: ComparisonResult | null; pending: boolean; error?: string; labels?: [string, string] }) {
  const comparison = result?.comparison, texts = result?.texts ?? null;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const fitEditor = useRef<() => void>(() => {});
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const monaco = ensureMonaco();
    const diff = monaco.editor.createDiffEditor(element, {
      readOnly: true, originalEditable: false, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false,
      automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontFamily: MONO_FONT, fontSize: 12, lineHeight: 20,
      lineNumbersMinChars: 3, renderOverviewRuler: true, ignoreTrimWhitespace: false, renderIndicators: true, diffWordWrap: 'off',
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 }, maxComputationTime: 60000, maxFileSize: 256,
      ariaLabel: `Differences between ${labels[0]} and ${labels[1]}`,
    });
    editor.current = diff;
    // Fill the rest of the scrolling Tools body, whatever the window size; below 320px the body scrolls instead.
    const container = element.closest<HTMLElement>('.lab-body') ?? element.parentElement!;
    const fit = () => {
      if (element.hidden) return;
      const top = element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      const height = Math.max(320, Math.floor(container.clientHeight - top - parseFloat(getComputedStyle(container).paddingBottom || '0')));
      if (element.style.height !== `${height}px`) element.style.height = `${height}px`;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    fitEditor.current = fit;
    fit();
    return () => { observer.disconnect(); fitEditor.current = () => {}; const model = diff.getModel(); diff.dispose(); model?.original.dispose(); model?.modified.dispose(); editor.current = null; };
  }, []);
  useEffect(() => {
    const diff = editor.current;
    if (!diff || !texts) return;
    const monaco = ensureMonaco();
    const previous = diff.getModel();
    const language = Math.max(texts.original.length, texts.modified.length) > HIGHLIGHT_LIMIT ? PLAIN_JSON : 'json';
    diff.setModel({ original: monaco.editor.createModel(texts.original, language), modified: monaco.editor.createModel(texts.modified, language) });
    previous?.original.dispose(); previous?.modified.dispose();
  }, [texts]);
  // Content above the editor (warnings, options) can move it without resizing the body; refit after every render.
  useLayoutEffect(() => { fitEditor.current(); });
  return <div className="capture-diff" aria-busy={pending}>
    {error && <p role="alert" className="error-text">{error}</p>}
    {pending && <p className="capture-diff-loading" role="status"><Loader2 className="spin" size={14} aria-hidden="true" />Comparing…</p>}
    {comparison && !pending && <>
      {comparison.warnings.map((warning, index) => <p className="muted" key={index}>{warning}</p>)}
      <p className="capture-diff-summary" role="status">{comparison.limited ? 'Comparison not evaluated' : `${comparison.totalChanges} differences${comparison.incomplete ? ' in retained content' : ''}`}</p>
    </>}
    <div className="capture-diff-labels" aria-hidden="true" hidden={!texts}><span>{labels[0]}</span><span>{labels[1]}</span></div>
    <div className={`capture-diff-editor${pending ? ' stale' : ''}`} ref={host} hidden={!texts} />
    {comparison && !pending && !comparison.limited && comparison.totalChanges > 0 && <details className="capture-diff-paths">
      <summary>Changed paths ({comparison.totalChanges})</summary>
      <ul>{comparison.changes.map((change, index) => <li key={index}><code>{change.path}</code>{change.before === undefined ? <span className="added"> only in {labels[1]}</span> : change.after === undefined ? <span className="removed"> only in {labels[0]}</span> : null}</li>)}</ul>
      {comparison.totalChanges > comparison.changes.length && <p className="muted">First {comparison.changes.length}</p>}
    </details>}
  </div>;
}
