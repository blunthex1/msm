// Renders assets/icon.svg into the PNG/ICO icons used by the extension and app.
// Needs Playwright (npm i --no-save playwright) and ImageMagick (`magick`/`convert`) for the .ico.

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(path.join(root, 'assets', 'icon.svg'), 'utf8');
const { chromium } = await import('playwright');

const browser = await chromium.launch();
const page = await browser.newPage();

async function render(size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await writeFile(
    file,
    await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }),
  );
  return file;
}

for (const size of [16, 32, 48, 128])
  await render(size, path.join(root, 'extension', 'icons', `icon${size}.png`));
await render(512, path.join(root, 'app', 'build', 'icon.png'));

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const tmp = [];
for (const size of icoSizes)
  tmp.push(await render(size, path.join(root, 'app', 'build', `.ico-${size}.png`)));
await browser.close();

const im = (() => {
  try {
    execFileSync('magick', ['-version']);
    return 'magick';
  } catch {
    return 'convert';
  }
})();
execFileSync(im, [...tmp, path.join(root, 'app', 'build', 'icon.ico')]);
execFileSync(
  process.platform === 'win32' ? 'cmd' : 'rm',
  process.platform === 'win32' ? ['/c', 'del', ...tmp] : tmp,
);
console.log('Icons written.');
