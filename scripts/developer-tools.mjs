import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', error => { cleanup(); reject(new Error(`Cannot run ${command}: ${error.message}`)); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal || code}). See output above.`));
    });
  });
}

export function dependencyStamp(project, packaging, constraints = '') {
  return createHash('sha256').update(project).update(packaging ? 'package' : 'dev').update(constraints).digest('hex');
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function supportsPython(command) {
  try {
    await run(command, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

export async function prepare({ packaging = false } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Install Node.js 22.12 or newer, then rerun this command.');
  if (!await exists(path.join(root, 'node_modules/electron/path.txt')) || !await exists(path.join(root, 'node_modules/vite/bin/vite.js')) || !await exists(path.join(root, 'node_modules/electron-builder/cli.js'))) {
    console.log('Installing JavaScript dependencies from package-lock.json…');
    await run(npm, ['ci']);
  }
  const python = process.env.STREAMGLASS_PYTHON || path.join(root, '.venv/bin/python');
  if (!await exists(python) && !process.env.STREAMGLASS_PYTHON) {
    let base;
    for (const candidate of ['python3', 'python3.14', 'python3.13', 'python3.12']) {
      if (await supportsPython(candidate)) { base = candidate; break; }
    }
    if (!base) throw new Error('Python 3.12 or newer is required. Install it (for example: brew install python@3.13), then rerun this command.');
    console.log(`Creating .venv with ${base}…`);
    await run(base, ['-m', 'venv', path.join(root, '.venv')]);
  }
  if (!await supportsPython(python)) throw new Error(`${python} must be Python 3.12 or newer. Set STREAMGLASS_PYTHON to a compatible environment or recreate .venv.`);
  const imports = ['import mitmproxy, aiohttp',
    'from importlib.metadata import version',
    'assert version("mitmproxy") == "12.2.3+streamglass.1", "Run the compatibility dependency setup"',
    ...(packaging ? ['import PyInstaller'] : [])].join('; ');
  if (process.env.STREAMGLASS_PYTHON) {
    try { await run(python, ['-c', imports], { stdio: 'ignore' }); }
    catch { throw new Error(`Prepare dependencies first: ${python} scripts/prepare_mitmproxy.py, then ${python} -m pip install --find-links build/wheels -c constraints-macos.txt -e '${packaging ? '.[package]' : '.'}'`); }
    return python;
  }
  const stampFile = path.join(root, '.venv', packaging ? '.streamglass-package' : '.streamglass-dev');
  const constraints = path.join(root, 'constraints-macos.txt');
  const stamp = dependencyStamp(await readFile(path.join(root, 'pyproject.toml')), packaging,
    Buffer.concat([await readFile(constraints), await readFile(path.join(root, 'scripts/prepare_mitmproxy.py'))]));
  let valid = false;
  if (await exists(stampFile) && (await readFile(stampFile, 'utf8')) === stamp) {
    try { await run(python, ['-c', imports], { stdio: 'ignore' }); valid = true; } catch {}
  }
  if (!valid) {
    console.log('Installing Python dependencies…');
    await run(python, [path.join(root, 'scripts/prepare_mitmproxy.py')]);
    await run(python, ['-m', 'pip', 'install', '--find-links', path.join(root, 'build/wheels'), '-c', constraints, '-e', packaging ? '.[package]' : '.']);
    await run(python, ['-c', imports]);
    await writeFile(stampFile, stamp);
  }
  return python;
}

export function releaseOptions({ version, signed = false, now = new Date() }) {
  const folder = path.join(root, 'release/local', `${version}-${now.toISOString().replace(/[:.]/g, '-')}`);
  return {
    folder,
    args: ['node_modules/electron-builder/cli.js', '--mac', '--publish', 'never', `--config.directories.output=${folder}`, ...(signed ? ['--config.forceCodeSigning=true'] : ['--config.mac.identity=null', '--config.mac.notarize=false', '--config.mac.hardenedRuntime=false', '--config.afterPack=scripts/adhoc-sign.cjs'])],
    env: signed ? { ...process.env } : { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  };
}

export async function reserveReleaseFolder(folder) {
  await mkdir(path.dirname(folder), { recursive: true });
  await mkdir(folder);
}

const releaseFolderName = /^\d+\.\d+\.\d+\S*-\d{4}-\d{2}-\d{2}T[\d-]+Z$/;

export async function pruneReleaseFolders(keepFolder) {
  const parent = path.dirname(keepFolder);
  const removed = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === path.basename(keepFolder) || !releaseFolderName.test(entry.name)) continue;
    await rm(path.join(parent, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
