import { useEffect, useMemo, useRef } from 'react';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { prepareJson } from './json-viewer.mjs';
import type { JsonContainer } from './json-viewer.mjs';
import { ensureMonaco, MAX_EDITOR_HEIGHT, sharedEditorOptions } from './monaco-setup';
import './json-viewer.css';

// `onReplace` and `disabled` are accepted for source compatibility; the viewer is read-only and users edit text directly elsewhere.
type Props = { value: unknown; unavailable?: boolean; preserveFormatting?: boolean; onReplace?: (range: JsonContainer) => void; disabled?: boolean };
export default function JsonViewer({ value, unavailable = false, preserveFormatting = false }: Props) {
  const document = useMemo(() => {
    if (unavailable) return { text: 'Body streamed to the client and not retained.', isJson: false };
    const prepared = prepareJson(value);
    return preserveFormatting && typeof value === 'string' ? { ...prepared, text: value } : prepared;
  }, [value, unavailable, preserveFormatting]);
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const initial = useRef(document);
  useEffect(() => {
    const monaco = ensureMonaco();
    const element = host.current;
    if (!element) return;
    const editor = monaco.editor.create(element, {
      ...sharedEditorOptions(initial.current.text.length),
      value: initial.current.text,
      language: initial.current.isJson ? 'json' : 'plaintext',
      readOnly: true,
      domReadOnly: false,
      tabFocusMode: true,
      ariaLabel: initial.current.isJson ? 'JSON body text' : 'Body text',
      renderValidationDecorations: 'off'
    });
    editorRef.current = editor;
    const fit = () => {
      const height = Math.min(MAX_EDITOR_HEIGHT, Math.max(editor.getContentHeight(), 36));
      element.style.height = `${height}px`;
      editor.layout();
    };
    fit();
    const sizeListener = editor.onDidContentSizeChange(fit);
    return () => { sizeListener.dispose(); editor.getModel()?.dispose(); editor.dispose(); editorRef.current = null; };
  }, []);
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (model.getValue() !== document.text) model.setValue(document.text);
    editor.updateOptions({ ...sharedEditorOptions(document.text.length), ariaLabel: document.isJson ? 'JSON body text' : 'Body text', readOnly: true, tabFocusMode: true, renderValidationDecorations: 'off' });
    ensureMonaco().editor.setModelLanguage(model, document.isJson ? 'json' : 'plaintext');
    editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
  }, [document]);
  return <section className="json-viewer" aria-label={document.isJson ? 'JSON body' : 'Body'}>
    <div className="json-monaco" ref={host}/>
  </section>;
}
