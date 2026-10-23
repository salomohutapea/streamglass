// Update notifications for unsigned builds. Squirrel.Mac (Electron's autoUpdater) refuses updates that are not signed by
// the same Apple Developer ID, so this only reports a newer GitHub release and sends the user to its download page.
export const releaseRepo = 'salomohutapea/streamglass';
export const releasesPrefix = `https://github.com/${releaseRepo}/releases/`;
const semver = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function compareVersions(a, b) {
  const left = semver.exec(a), right = semver.exec(b);
  if (!left || !right) return 0;
  for (let index = 1; index <= 3; index++) if (left[index] !== right[index]) return Number(left[index]) - Number(right[index]);
  return 0;
}

export function parseLatestRelease(release, currentVersion) {
  if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string') return null;
  const version = release.tag_name.replace(/^v/, '');
  if (!semver.test(version) || compareVersions(version, currentVersion) <= 0) return null;
  const url = typeof release.html_url === 'string' && release.html_url.startsWith(releasesPrefix) ? release.html_url : `${releasesPrefix}tag/${release.tag_name}`;
  return { version, url };
}

export function createUpdateChecker({ currentVersion, fetchImpl = fetch, now = Date.now, intervalMs = 6 * 60 * 60 * 1000 }) {
  let last = null, cached = null;
  return async function check({ force = false } = {}) {
    if (!force && last !== null && now() - last < intervalMs) return cached;
    try {
      // identity keeps Node's Brotli/gzip decoders off network data (CVE-2026-111497 until Electron ships Node 24.22.1).
      const response = await fetchImpl(`https://api.github.com/repos/${releaseRepo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'Accept-Encoding': 'identity', 'User-Agent': 'Streamglass' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
      cached = parseLatestRelease(await response.json(), currentVersion);
      last = now();
    } catch { cached = null; last = now() - intervalMs + 10 * 60 * 1000; }
    return cached;
  };
}
