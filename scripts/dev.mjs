import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
import { prepare, root } from './developer-tools.mjs';

async function checkPort(port, label) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`${label} port ${port} is already in use. Stop the process using it, then rerun npm run dev.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

const children = new Set();
let stopping = false;
function signal(child, name) {
  try {
    if (process.platform === 'win32') child.kill(name);
    else process.kill(-child.pid, name);
  } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
}
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) signal(child, 'SIGTERM');
  // Give Electron time to stop its engine, then terminate any surviving process group.
  const groups = [...children];
  setTimeout(5000).then(() => { for (const child of groups) signal(child, 'SIGKILL'); });
}
function launch(command, args, env, desktop = false) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env, detached: process.platform !== 'win32' });
  children.add(child);
  child.once('error', error => { children.delete(child); console.error(error.message); stop(1); });
  child.once('exit', code => {
    if (!stopping) stop(desktop ? (code ?? 1) : (code || 1));
    children.delete(child);
  });
  return child;
}

try {
  const python = await prepare();
  const electron = (await import('electron')).default;
  const env = {
    ...process.env,
    STREAMGLASS_PYTHON: python,
    STREAMGLASS_DATA_DIR: process.env.STREAMGLASS_DATA_DIR || path.join(root, '.streamglass-dev'),
    STREAMGLASS_PROXY_PORT: process.env.STREAMGLASS_PROXY_PORT || '18080',
    STREAMGLASS_MCP_PORT: process.env.STREAMGLASS_MCP_PORT || '48723',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.STREAMGLASS_BUILT_UI;
  await checkPort(5173, 'Vite');
  await checkPort(Number(env.STREAMGLASS_MCP_PORT), 'MCP');
  await checkPort(Number(env.STREAMGLASS_PROXY_PORT), 'Initial proxy');
  console.log(`Development UI: http://127.0.0.1:5173\nDevelopment profile: ${env.STREAMGLASS_DATA_DIR}\nInitial proxy port: ${env.STREAMGLASS_PROXY_PORT}; MCP port: ${env.STREAMGLASS_MCP_PORT}`);
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  launch(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'frontend/vite.config.ts', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], env);
  let ready = false;
  for (let i = 0; i < 150 && !stopping; i++) {
    try { if ((await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(300) })).ok) { ready = true; break; } } catch {}
    await setTimeout(100);
  }
  if (!ready && !stopping) throw new Error('UI server did not start within 15 seconds. See Vite output above.');
  if (!stopping) launch(electron, ['.'], env, true);
} catch (error) {
  console.error(error.message);
  stop(1);
}
