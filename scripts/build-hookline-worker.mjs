// scripts/build-hookline-worker.mjs
//
// Builds the Cloudflare Worker-compatible ESM artifact for Hookline:
//
//   1. Reads the existing static bundle: dist/index.html, dist/styles.css,
//      dist/app.js, dist/execution-rail.js, dist/hooks.json,
//      dist/token-hooks.json and dist/runtime-families.json.
//   2. Validates the assets (must not contain inline <script> bodies or
//      server-side template syntax).
//   3. Reads worker/index.js (the maintainable runtime source).
//   4. Embeds the four assets safely via JSON.stringify at the
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

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
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
const botSrcDir = join(root, 'bot');
const botOutDir = join(dist, 'bot');
const projectSrcDir = join(root, 'projects');
const projectOutDir = join(dist, 'projects');
const accountSrcDir = join(root, 'accounts');
const accountOutDir = join(dist, 'accounts');

// The wallet SDK is isolated from the server's execution/x402 dependencies.
execFileSync(process.execPath, [join(root,'scripts/build-wallet-client.mjs')], {cwd:root,stdio:'inherit'});

// --- Read required inputs ---------------------------------------------------

const htmlPath = join(dist, 'index.html');
const cssPath = join(dist, 'styles.css');
const appPath = join(dist, 'app.js');
const executionRailPath = join(dist, 'execution-rail.js');
const accountsUiPath = join(dist, 'accounts-ui.js');
const hooksPath = join(dist, 'hooks.json');
const tokenHooksPath = join(dist, 'token-hooks.json');
const runtimeFamiliesPath = join(dist, 'runtime-families.json');
const projectsPath = join(root, 'data', 'project-seeds.json');

const missing = [];
for (const p of [htmlPath, cssPath, appPath, executionRailPath, accountsUiPath, hooksPath, tokenHooksPath, runtimeFamiliesPath, projectsPath]) {
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
const executionRail = readFileSync(executionRailPath, 'utf8');
const accountsUi = readFileSync(accountsUiPath, 'utf8');
const privyWallet = readFileSync(join(dist,'privy-wallet.js'), 'utf8');
const hooks = readFileSync(hooksPath, 'utf8');
const tokenHooks = readFileSync(tokenHooksPath, 'utf8');
const runtimeFamilies = readFileSync(runtimeFamiliesPath, 'utf8');
const projects = readFileSync(projectsPath, 'utf8');
const runtime = readFileSync(workerSrc, 'utf8');

const assetVersion = createHash('sha256')
  .update(css)
  .update(app)
  .update(executionRail)
  .update(accountsUi)
  .update(privyWallet)
  .update(hooks)
  .update(tokenHooks)
  .update(runtimeFamilies)
  .update(projects)
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
  ['execution-rail.js', executionRail],
  ['accounts-ui.js', accountsUi],
  ['hooks.json', hooks],
  ['token-hooks.json', tokenHooks],
  ['runtime-families.json', runtimeFamilies],
  ['project-seeds.json', projects],
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
  `  version: ${JSON.stringify(assetVersion)},\n` +
  `  html: ${JSON.stringify(versionedHtml)},\n` +
  `  css: ${JSON.stringify(css)},\n` +
  `  app: ${JSON.stringify(app)},\n` +
  `  executionRail: ${JSON.stringify(executionRail)},\n` +
  `  accountsUi: ${JSON.stringify(accountsUi)},\n` +
  `  privyWallet: ${JSON.stringify(privyWallet)},\n` +
  `  hooks: ${JSON.stringify(hooks)},\n` +
  `  tokenHooks: ${JSON.stringify(tokenHooks)},\n` +
  `  runtimeFamilies: ${JSON.stringify(runtimeFamilies)},\n` +
  `  projects: ${JSON.stringify(projects)},\n` +
  `});\n`;

const emitted = runtime.replace(/\/\* @ASSETS-INJECT \*\/\s*\n?/s, () => assetsBlock);

// --- Write the self-contained artifact --------------------------------------

mkdirSync(outDir, { recursive: true });
writeFileSync(out, emitted, 'utf8');

// The worker imports the portable Telegram runtime. Copy only browser/Worker
// compatible modules; the Node server and tests stay outside the deployment.
mkdirSync(botOutDir, { recursive: true });
for (const name of readdirSync(botSrcDir)) {
  if (!name.endsWith('.js') || name === 'server.js') continue;
  copyFileSync(join(botSrcDir, name), join(botOutDir, name));
}
mkdirSync(projectOutDir, { recursive: true });
for (const name of readdirSync(projectSrcDir)) {
  if (name.endsWith('.js')) copyFileSync(join(projectSrcDir,name),join(projectOutDir,name));
}
mkdirSync(accountOutDir, { recursive: true });
for (const name of readdirSync(accountSrcDir)) {
  if (name.endsWith('.js') && !name.endsWith('.test.js')) copyFileSync(join(accountSrcDir,name),join(accountOutDir,name));
}

// --- Sanity check: the artifact must parse as valid ESM --------------------

try {
  execFileSync('node', ['--check', out], { stdio: 'inherit', cwd: root });
  console.log(`✓ ${out} syntax-checked OK`);
} catch (err) {
  console.error(`✗ ${out} failed syntax check`);
  throw err;
}

console.log(`✓ Built Cloudflare Worker artifact: ${out}`);
console.log(`  embedded static assets: index.html (${versionedHtml.length} bytes), styles.css (${css.length} bytes), app.js (${app.length} bytes), execution-rail.js (${executionRail.length} bytes), hooks.json (${hooks.length} bytes), token-hooks.json (${tokenHooks.length} bytes), runtime-families.json (${runtimeFamilies.length} bytes)`);
console.log(`  asset version: ${assetVersion}`);
