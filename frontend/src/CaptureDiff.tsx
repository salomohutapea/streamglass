import { useEffect, useMemo, useRef } from 'react';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { comparisonText } from './capture-tools.mjs';
import { ensureMonaco, MONO_FONT } from './monaco-setup';
import './capture-diff.css';

type Options = { section: 'request' | 'response' | 'events'; ignoreFields: string[]; eventKey: 'sequence' | 'id' };
type Comparison = { changes: { path: string; before?: string; after?: string }[]; totalChanges: number; limited?: boolean; incomplete?: boolean; warnings: string[] };

// VS Code's side-by-side diff over both captures as pretty JSON: removed text is red on A, added text green on B,
// and long identical stretches fold away. The changed-path list stays available below for exact values.
export default function CaptureDiff({ left, right, options, comparison, labels = ['A', 'B'] }: { left: any; right: any; options: Options; comparison: Comparison; labels?: [string, string] }) {
  const texts = useMemo(() => comparison.limited ? null : { original: comparisonText(left, options), modified: comparisonText(right, options) }, [left, right, options.section, options.eventKey, options.ignoreFields.join(','), comparison.limited]);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const monaco = ensureMonaco();
    const diff = monaco.editor.createDiffEditor(element, {
      readOnly: true, originalEditable: false, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false,
      automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontFamily: MONO_FONT, fontSize: 12, lineHeight: 20,
      lineNumbersMinChars: 3, renderOverviewRuler: true, ignoreTrimWhitespace: false, renderIndicators: true, diffWordWrap: 'off',
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 }, maxComputationTime: 5000,
      ariaLabel: `Differences between ${labels[0]} and ${labels[1]}`,
    });
    editor.current = diff;
    return () => { const model = diff.getModel(); diff.dispose(); model?.original.dispose(); model?.modified.dispose(); editor.current = null; };
  }, []);
  useEffect(() => {
    const diff = editor.current;
    if (!diff || !texts) return;
    const monaco = ensureMonaco();
    const previous = diff.getModel();
    diff.setModel({ original: monaco.editor.createModel(texts.original, 'json'), modified: monaco.editor.createModel(texts.modified, 'json') });
    previous?.original.dispose(); previous?.modified.dispose();
  }, [texts]);
  return <div className="capture-diff">
    {comparison.warnings.map((warning, index) => <p className="muted" key={index}>{warning}</p>)}
    <p className="capture-diff-summary" role="status">{comparison.limited ? 'Comparison not evaluated' : `${comparison.totalChanges} differences${comparison.incomplete ? ' in retained content' : ''}`}</p>
    <div className="capture-diff-labels" aria-hidden="true" hidden={!texts}><span>{labels[0]}</span><span>{labels[1]}</span></div>
    <div className="capture-diff-editor" ref={host} hidden={!texts} />
    {!comparison.limited && comparison.totalChanges > 0 && <details className="capture-diff-paths">
      <summary>Changed paths ({comparison.totalChanges})</summary>
      <ul>{comparison.changes.map((change, index) => <li key={index}><code>{change.path}</code>{change.before === undefined ? <span className="added"> only in {labels[1]}</span> : change.after === undefined ? <span className="removed"> only in {labels[0]}</span> : null}</li>)}</ul>
      {comparison.totalChanges > comparison.changes.length && <p className="muted">Showing the first {comparison.changes.length} paths.</p>}
    </details>}
  </div>;
}
