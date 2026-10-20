/// <reference types="vite/client" />

declare module 'monaco-editor/editor/contrib/*';
declare module 'monaco-editor/editor/browser/*';
declare module 'monaco-editor/languages/features/json/register.js' {
  export const jsonDefaults: {
    setDiagnosticsOptions(options: { validate?: boolean; allowComments?: boolean; schemaValidation?: 'error' | 'warning' | 'ignore'; trailingCommas?: 'error' | 'warning' | 'ignore' }): void;
  };
}
