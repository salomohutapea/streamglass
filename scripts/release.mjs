import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepare, pruneReleaseFolders, releaseOptions, reserveReleaseFolder, root, run, npm } from './developer-tools.mjs';
try {
  const flags = process.argv.slice(2);
  if (flags.some(flag => flag !== '--signed' && flag !== '--keepPreviousBuilds')) throw new Error('Usage: npm run build:release -- [--signed] [--keepPreviousBuilds]');
  if (process.platform !== 'darwin') throw new Error('The macOS release must be built on macOS.');
  const python = await prepare({ packaging: true });
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const options = releaseOptions({ version, signed: flags.includes('--signed') });
  await reserveReleaseFolder(options.folder);
  await run(npm, ['run', 'build:ui']);
  await run(python, ['scripts/package_engine.py']);
  await run(process.execPath, options.args, { env: options.env });
  if (!flags.includes('--keepPreviousBuilds')) {
    const removed = await pruneReleaseFolders(options.folder);
    if (removed.length) console.log(`Removed ${removed.length} previous build${removed.length === 1 ? '' : 's'} (use --keepPreviousBuilds to keep them).`);
  }
  console.log(`Release ready: ${options.folder}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
