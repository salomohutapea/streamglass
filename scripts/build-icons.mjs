import { chromium } from 'playwright';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'build/icons');
const iconset = path.join(output, 'Streamglass.iconset');
await mkdir(iconset, { recursive: true });
const svg = await readFile(path.join(root, 'frontend/src/assets/streamglass.svg'), 'utf8');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: scale });
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
      await page.screenshot({ path: path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), omitBackground: true });
      await page.close();
    }
  }
} finally { await browser.close(); }
execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(output, 'Streamglass.icns')]);
await mkdir(path.join(root, 'electron/assets'), { recursive: true });
await copyFile(path.join(iconset, 'icon_512x512.png'), path.join(root, 'electron/assets/streamglass.png'));
await copyFile(path.join(output, 'Streamglass.icns'), path.join(root, 'electron/assets/Streamglass.icns'));
console.log('Created build/icons/Streamglass.icns from the vector logo.');
