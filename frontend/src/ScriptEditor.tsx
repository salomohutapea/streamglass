import { useEffect, useRef } from 'react';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/javascript/register.js';
import { ensureMonaco, MAX_EDITOR_HEIGHT, sharedEditorOptions } from './monaco-setup';
import './json-viewer.css';

// JavaScript rule source backed by Monaco. Highlighting only (Monarch tokenizer): no TypeScript worker, nothing is rewritten.
type Props = { value: string; label: string; disabled?: boolean; onChange: (value: string) => void };
const MIN_HEIGHT = 280;
export default function ScriptEditor({ value, label, disabled = false, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const programmatic = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  const initial = useRef({ value, label, disabled });
  useEffect(() => {
    const monaco = ensureMonaco();
    const element = host.current;
    if (!element) return;
    const editor = monaco.editor.create(element, {
      ...sharedEditorOptions(initial.current.value.length),
      value: initial.current.value,
      language: 'javascript',
      readOnly: initial.current.disabled,
      ariaLabel: initial.current.label,
      tabFocusMode: false,
      fixedOverflowWidgets: true
    });
    editorRef.current = editor;
    const fit = () => {
      const height = Math.min(MAX_EDITOR_HEIGHT, Math.max(editor.getContentHeight(), MIN_HEIGHT));
      element.style.height = `${height}px`;
      editor.layout();
    };
    fit();
    const sizeListener = editor.onDidContentSizeChange(fit);
    const contentListener = editor.onDidChangeModelContent(() => { if (!programmatic.current) change.current(editor.getValue()); });
    return () => { sizeListener.dispose(); contentListener.dispose(); editor.getModel()?.dispose(); editor.dispose(); editorRef.current = null; };
  }, []);
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) { programmatic.current = true; try { editor.setValue(value); } finally { programmatic.current = false; } }
  }, [value]);
  useEffect(() => { editorRef.current?.updateOptions({ readOnly: disabled, ariaLabel: label }); }, [disabled, label]);
  return <div className="json-viewer json-monaco-editable"><div className="json-monaco" ref={host}/></div>;
}
