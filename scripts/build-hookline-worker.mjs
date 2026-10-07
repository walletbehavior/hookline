// scripts/build-hookline-worker.mjs
//
// Builds the Cloudflare Worker-compatible ESM artifact for Hookline:
//
//   1. Reads the existing static bundle: dist/index.html, dist/styles.css,
//      dist/app.js.
//   2. Validates the assets (must not contain inline <script> bodies or
//      server-side template syntax).
//   3. Reads worker/index.js (the maintainable runtime source).
//   4. Embeds the three assets safely via JSON.stringify at the
//      @ASSETS-INJECT injection point in worker/index.js.
//   5. Writes one self-contained artifact at dist/server/index.js exporting
//      default.fetch(request, env, ctx).
//   6. Runs `node --check` on the emitted artifact and fails if it is invalid.
//
// JSON.stringify guarantees a faithful, safely-escaped embedding: the round
// trip JSON.parse(JSON.stringify(content)) === content is lossless, so the
// worker reconstructs the exact original bytes.
//
// Usage: node scripts/build-hookline-worker.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = join(root, 'dist');
const workerSrc = join(root, 'worker', 'index.js');
const outDir = join(dist, 'server');
const out = join(outDir, 'index.js');

// --- Read required inputs ---------------------------------------------------

const htmlPath = join(dist, 'index.html');
const cssPath = join(dist, 'styles.css');
const appPath = join(dist, 'app.js');

const missing = [];
for (const p of [htmlPath, cssPath, appPath]) {
  try {
    readFileSync(p, 'utf8');
  } catch {
    missing.push(p);
  }
}
if (missing.length) {
  throw new Error(`missing static bundle assets (build the project first): ${missing.join(', ')}`);
}

const html = readFileSync(htmlPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const app = readFileSync(appPath, 'utf8');
const runtime = readFileSync(workerSrc, 'utf8');

const assetVersion = createHash('sha256')
  .update(css)
  .update(app)
  .digest('hex')
  .slice(0, 12);
const versionedHtml = html
  .replace('href="styles.css"', `href="/assets/${assetVersion}/styles.css"`)
  .replace('src="app.js"', `src="/assets/${assetVersion}/app.js"`);

if (versionedHtml === html) {
  throw new Error('index.html is missing the expected stylesheet and script references');
}

if (!runtime.includes('/* @ASSETS-INJECT */')) {
  throw new Error('worker/index.js is missing the @ASSETS-INJECT injection marker');
}

// --- Safety checks ----------------------------------------------------------

// The injected assets are only ever serialized into JSON string literals.
// They must never contain an inline script body that would execute at
// page-load time, and they must never contain server-side template syntax
// that would leak into the bundle.
for (const [name, content] of [
  ['index.html', html],
  ['styles.css', css],
  ['app.js', app],
]) {
  const inlineScriptRe = /<\s*script\b(?![^>]*\bsrc\s*=)/;
  if (inlineScriptRe.test(content)) {
    throw new Error(`asset ${name} must not contain inline <script> bodies`);
  }
  if (/<\?xml/.test(content) || /<%/.test(content) || /<%=/.test(content)) {
    throw new Error(`asset ${name} contains server-side template syntax`);
  }
}

// --- Embed via JSON.stringify -----------------------------------------------

// JSON.stringify produces a faithful JavaScript string literal.  The round
// trip JSON.parse(JSON.stringify(content)) === content is lossless, so the
// worker reconstructs the exact original file bytes.  Wrapping in Object.freeze
// signals that the embedded assets are immutable.
const assetsBlock =
  `const ASSETS = Object.freeze({\n` +
  `  html: ${JSON.stringify(versionedHtml)},\n` +
  `  css: ${JSON.stringify(css)},\n` +
  `  app: ${JSON.stringify(app)},\n` +
  `});\n`;

const emitted = runtime.replace(/\/\* @ASSETS-INJECT \*\/\s*\n?/s, () => assetsBlock);

// --- Write the self-contained artifact --------------------------------------

mkdirSync(outDir, { recursive: true });
writeFileSync(out, emitted, 'utf8');

// --- Sanity check: the artifact must parse as valid ESM --------------------

try {
  execFileSync('node', ['--check', out], { stdio: 'inherit', cwd: root });
  console.log(`✓ ${out} syntax-checked OK`);
} catch (err) {
  console.error(`✗ ${out} failed syntax check`);
  throw err;
}

console.log(`✓ Built Cloudflare Worker artifact: ${out}`);
console.log(`  embedded static assets: index.html (${versionedHtml.length} bytes), styles.css (${css.length} bytes), app.js (${app.length} bytes)`);
console.log(`  asset version: ${assetVersion}`);
