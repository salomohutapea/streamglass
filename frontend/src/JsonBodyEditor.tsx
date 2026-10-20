import { useEffect, useRef } from 'react';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { ensureMonaco, MAX_EDITOR_HEIGHT, sharedEditorOptions } from './monaco-setup';
import './json-viewer.css';

// Fully editable body backed by Monaco. JSON syntax is validated by the JSON language service (squiggles); nothing is rewritten.
type Props = { value: string; label: string; disabled?: boolean; onChange: (value: string) => void; onReplacingChange: (editing: boolean) => void };
const MIN_HEIGHT = 190;
export default function JsonBodyEditor({ value, label, disabled = false, onChange, onReplacingChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const programmatic = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  const initial = useRef({ value, label, disabled });
  useEffect(() => { onReplacingChange(false); }, [onReplacingChange]);
  useEffect(() => {
    const monaco = ensureMonaco();
    const element = host.current;
    if (!element) return;
    const editor = monaco.editor.create(element, {
      ...sharedEditorOptions(initial.current.value.length),
      value: initial.current.value,
      language: 'json',
      readOnly: initial.current.disabled,
      ariaLabel: initial.current.label,
      tabFocusMode: false,
      renderValidationDecorations: 'on',
      fixedOverflowWidgets: true
    });
    editorRef.current = editor;
    // Monaco would otherwise consume Cmd+Enter (insert line below); hand it to the window's Continue shortcut instead.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    });
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
  useEffect(() => () => onReplacingChange(false), [onReplacingChange]);
  return <div className="json-body-editor"><div className="json-viewer json-monaco-editable"><div className="json-monaco" ref={host}/></div></div>;
}
