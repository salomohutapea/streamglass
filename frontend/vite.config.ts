import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
// Monaco ships its own copy of DOMPurify; build with the patched npm release (see package.json overrides) instead.
const dompurify = fileURLToPath(new URL('../node_modules/dompurify/dist/purify.es.mjs', import.meta.url));
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins: [react()], base: './', resolve: { alias: [{ find: /^\.\/dompurify\/dompurify\.js$/, replacement: dompurify }] }, server: { host: '127.0.0.1', port: 5173, strictPort: true }, worker: { format: 'es' }, build: { outDir: 'dist' } });
