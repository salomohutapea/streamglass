import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const semver = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current, request) {
  const match = semver.exec(current);
  if (!match) throw new Error(`Current version "${current}" is not x.y.z.`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (request === 'major') return `${major + 1}.0.0`;
  if (request === 'minor') return `${major}.${minor + 1}.0`;
  if (request === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (!semver.test(request)) throw new Error('Use patch, minor, major, or an exact x.y.z version.');
  return request;
}

export async function applyVersion(directory, version) {
  const json = async (file, edit) => {
    const target = path.join(directory, file);
    const value = JSON.parse(await readFile(target, 'utf8'));
    edit(value);
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  };
  await json('package.json', value => { value.version = version; });
  await json('package-lock.json', value => { value.version = version; if (value.packages?.['']) value.packages[''].version = version; });
  const pyproject = path.join(directory, 'pyproject.toml');
  const text = await readFile(pyproject, 'utf8');
  const updated = text.replace(/^version = "[^"]*"/m, `version = "${version}"`);
  if (updated === text && !text.includes(`version = "${version}"`)) throw new Error('Could not find the project version in pyproject.toml.');
  await writeFile(pyproject, updated);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const request = process.argv[2];
    if (!request || process.argv.length > 3) throw new Error('Usage: npm run bump -- <patch|minor|major|x.y.z>');
    const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const next = nextVersion(version, request);
    if (next === version) throw new Error(`Version is already ${version}.`);
    await applyVersion(root, next);
    console.log(next);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
