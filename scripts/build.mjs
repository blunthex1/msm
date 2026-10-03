// Builds the browser extension (dist/chrome, dist/firefox) and the desktop app's
// bundled preload/settings scripts (app/dist). Usage: node scripts/build.mjs [--watch]

import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (...p) => path.join(root, ...p);
const watch = process.argv.includes('--watch');
const pkg = JSON.parse(await readFile(r('package.json'), 'utf8'));

const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome120', 'firefox121'],
  logLevel: 'info',
  legalComments: 'none',
};

async function buildExtension(browser) {
  const out = r('dist', browser);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const manifest = JSON.parse(await readFile(r('extension', 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (browser === 'firefox') {
    manifest.browser_specific_settings = {
      gecko: { id: 'ai-filter@msm', strict_min_version: '121.0' },
    };
  }
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  await Promise.all([
    cp(r('extension', 'icons'), path.join(out, 'icons'), { recursive: true }),
    cp(r('core', 'filter.css'), path.join(out, 'filter.css')),
    cp(r('core', 'options', 'options.html'), path.join(out, 'options.html')),
    cp(r('core', 'options', 'options.css'), path.join(out, 'options.css')),
    cp(r('extension', 'src', 'popup.html'), path.join(out, 'popup.html')),
    cp(r('extension', 'src', 'popup.css'), path.join(out, 'popup.css')),
  ]);

  return {
    ...common,
    entryPoints: {
      content: r('extension', 'src', 'content.js'),
      options: r('extension', 'src', 'options-entry.js'),
      popup: r('extension', 'src', 'popup.js'),
    },
    outdir: out,
  };
}

async function buildApp() {
  const out = r('app', 'dist');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await Promise.all([
    cp(r('core', 'options', 'options.html'), path.join(out, 'settings.html')),
    cp(r('core', 'options', 'options.css'), path.join(out, 'options.css')),
  ]);
  return [
    {
      // Preloads run sandboxed, so everything they use must be bundled in.
      ...common,
      platform: 'browser',
      external: ['electron'],
      format: 'cjs',
      outExtension: { '.js': '.cjs' },
      loader: { '.css': 'text' },
      entryPoints: {
        'preload-youtube': r('app', 'src', 'preload-youtube.js'),
        'preload-settings': r('app', 'src', 'preload-settings.js'),
      },
      outdir: out,
    },
    {
      ...common,
      entryPoints: { options: r('app', 'src', 'settings-entry.js') },
      outdir: out,
    },
  ];
}

const configs = [await buildExtension('chrome'), await buildExtension('firefox'), ...(await buildApp())];

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
  console.log('Watching for changes…');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log(`Built extension (dist/chrome, dist/firefox) and app bundles (app/dist) v${pkg.version}`);
}
