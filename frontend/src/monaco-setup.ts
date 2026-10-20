// Local Monaco bootstrap: only the editor core, the JSON language and the VS Code features the body views need.
// Nothing is loaded from a CDN; workers are bundled by Vite and served from the app origin.
import * as monaco from 'monaco-editor/editor/editor.api';
// Same editor contributions as monaco's editor.main (services they register are required by the JSON language), minus other languages.
import 'monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/transpose.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js';
import 'monaco-editor/editor/contrib/codelens/browser/codelensController.js';
import 'monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js';
import 'monaco-editor/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js';
import 'monaco-editor/editor/contrib/dnd/browser/dnd.js';
import 'monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js';
import 'monaco-editor/editor/contrib/format/browser/formatActions.js';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-editor/editor/contrib/gpu/browser/gpuActions.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js';
import 'monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js';
import 'monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress.js';
import 'monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js';
import 'monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js';
import 'monaco-editor/editor/standalone/browser/inspectTokens/inspectTokens.js';
import 'monaco-editor/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js';
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing.js';
import 'monaco-editor/editor/contrib/links/browser/links.js';
import 'monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js';
import 'monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js';
import 'monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js';
import 'monaco-editor/editor/contrib/rename/browser/rename.js';
import 'monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions.js';
import 'monaco-editor/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js';
import 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js';
import 'monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/common/standaloneStrings.js';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_id, label) => label === 'json' ? new JsonWorker() : new EditorWorker()
};
jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: false, schemaValidation: 'ignore', trailingCommas: 'error' });

// Above this size folding, bracket matching and occurrence highlighting are switched off to stay responsive.
export const LARGE_DOCUMENT = 2 * 1024 * 1024;
export const MAX_EDITOR_HEIGHT = 560;
export const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function resolveColor(value: string, fallback: string): string {
  const probe = document.createElement('span');
  probe.style.color = fallback;
  probe.style.color = value;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const match = rgb.match(/[\d.]+/g);
  if (!match || match.length < 3) return fallback;
  const [r, g, b, a] = match.map(Number);
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}${a !== undefined && a < 1 ? hex(a * 255) : ''}`;
}

function defineAppTheme(): string {
  const light = document.documentElement.dataset.theme === 'light';
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => resolveColor(css.getPropertyValue(name).trim() || fallback, fallback);
  const background = token('--input', light ? '#ffffff' : '#1c1d20');
  const text = token('--text', light ? '#1f2024' : '#e7e8ec');
  const muted = token('--muted', '#80858e');
  const line = token('--line', light ? '#e8e8ed' : '#37383e');
  const selection = token('--selection', light ? '#eef1fd' : '#284d79');
  const accent = token('--accent', '#6b8bff');
  const strip = (color: string) => color.replace('#', '');
  const name = light ? 'streamglass-light' : 'streamglass-dark';
  monaco.editor.defineTheme(name, {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: strip(light ? '#0451a5' : '#9cdcfe') },
      { token: 'string.value.json', foreground: strip(light ? '#a31515' : '#ce9178') },
      { token: 'number.json', foreground: strip(light ? '#098658' : '#b5cea8') },
      { token: 'keyword.json', foreground: strip(light ? '#0000ff' : '#569cd6') },
      { token: 'delimiter.bracket.json', foreground: strip(light ? '#555555' : '#b8bbc3') },
      { token: 'delimiter.array.json', foreground: strip(light ? '#555555' : '#b8bbc3') },
      { token: 'delimiter.colon.json', foreground: strip(light ? '#555555' : '#b8bbc3') },
      { token: 'delimiter.comma.json', foreground: strip(light ? '#555555' : '#b8bbc3') }
    ],
    colors: {
      'editor.background': background,
      'editor.foreground': text,
      'editorLineNumber.foreground': muted,
      'editorLineNumber.activeForeground': text,
      'editorGutter.background': background,
      'editor.selectionBackground': selection,
      'editor.inactiveSelectionBackground': selection,
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': accent,
      'editorIndentGuide.background1': line,
      'editorWidget.background': background,
      'editorWidget.border': line,
      'editorSuggestWidget.background': background,
      'editor.findMatchBackground': accent + '66',
      'editor.findMatchHighlightBackground': accent + '33',
      'focusBorder': accent,
      'scrollbarSlider.background': muted + '33',
      'scrollbarSlider.hoverBackground': muted + '55',
      'scrollbarSlider.activeBackground': muted + '77',
      'editorOverviewRuler.border': '#00000000'
    }
  });
  return name;
}

let observing = false;
export function applyMonacoTheme(): void {
  monaco.editor.setTheme(defineAppTheme());
}
export function ensureMonaco(): typeof monaco {
  if (!observing) {
    observing = true;
    applyMonacoTheme();
    new MutationObserver(applyMonacoTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return monaco;
}

export function sharedEditorOptions(size: number): monaco.editor.IStandaloneEditorConstructionOptions {
  const large = size > LARGE_DOCUMENT;
  return {
    automaticLayout: true,
    minimap: { enabled: false },
    wordWrap: 'off',
    fontFamily: MONO_FONT,
    fontSize: 12,
    lineHeight: 20,
    lineNumbers: 'on',
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: !large,
    showFoldingControls: 'mouseover',
    matchBrackets: large ? 'never' : 'always',
    bracketPairColorization: { enabled: !large },
    occurrencesHighlight: large ? 'off' : 'singleFile',
    selectionHighlight: !large,
    renderLineHighlight: 'none',
    scrollBeyondLastLine: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    padding: { top: 8, bottom: 8 },
    scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    tabSize: 2,
    stickyScroll: { enabled: false },
    contextmenu: true,
    links: false,
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    codeLens: false,
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off }
  };
}
