// Reruns the measurement: node run.mjs [case-id ...]   (no ids: every case)
//
// Per case: the application's sources and the shared ones are copied into a work directory, the stand-in package is
// installed from a tarball (a copy in node_modules, as a registry install gives), the bundler builds or serves it,
// and Chromium (Playwright) opens the page, reads what the application measured, and compares the bytes it fetched
// with the package's file. Raw output goes to results/<id>.json, the build or server log to results/<id>.log.
// Work directory: $WORK, default <tmp>/web-sandbox-research-32 (installs stay out of the repository).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = resolve(process.env.WORK ?? join(tmpdir(), 'web-sandbox-research-32'));
const RESULTS = join(HERE, 'results');
const LOCK = '/home/user/.cache/web-sandbox-e2e.lock';
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/home/user/.cache/pw-project';
const PACKAGE_FILE = join(HERE, 'fake-sealed', 'sealed-document.html');
const EXPECTED_SHA = createHash('sha256').update(readFileSync(PACKAGE_FILE)).digest('hex');

const COPY_HTML = 'cp index.html dist/';
const CASES = [
  { id: 'cdn', app: 'cdn', serve: { static: '.' } },
  { id: 'vite-dev', app: 'vite', serve: { cmd: 'npx vite --host 127.0.0.1 --port $PORT --strictPort' } },
  { id: 'vite-dev-noprebundle', app: 'vite', serve: { cmd: 'npx vite --config vite.noprebundle.config.js --host 127.0.0.1 --port $PORT --strictPort' } },
  { id: 'vite-build', app: 'vite', build: 'npx vite build', serve: { static: 'dist' } },
  { id: 'vite-preview', app: 'vite', build: 'npx vite build', serve: { cmd: 'npx vite preview --host 127.0.0.1 --port $PORT --strictPort' } },
  { id: 'vite-build-htm', app: 'vite', variant: 'htm', build: 'npx vite build', serve: { static: 'dist' } },
  { id: 'vite-dev-htm', app: 'vite', variant: 'htm', serve: { cmd: 'npx vite --host 127.0.0.1 --port $PORT --strictPort' } },
  { id: 'webpack-build', app: 'webpack', build: `npx webpack && cp public/index.html dist/`, serve: { static: 'dist' } },
  { id: 'webpack-build-rule', app: 'webpack', build: `npx webpack -c webpack.rule.config.js && cp public/index.html dist/`, serve: { static: 'dist' } },
  { id: 'webpack-build-html-off', app: 'webpack', build: `npx webpack -c webpack.htmloff.config.js && cp public/index.html dist/`, serve: { static: 'dist' } },
  { id: 'webpack-dev-server', app: 'webpack', serve: { cmd: 'npx webpack serve --mode development' } },
  { id: 'webpack-build-htm', app: 'webpack', variant: 'htm', build: `npx webpack && cp public/index.html dist/`, serve: { static: 'dist' } },
  { id: 'rollup-plain', app: 'rollup', build: `npx rollup -c rollup.config.js && ${COPY_HTML}`, serve: { static: 'dist' } },
  { id: 'rollup-import-meta-assets', app: 'rollup', build: `npx rollup -c rollup.assets.config.js && ${COPY_HTML}`, serve: { static: 'dist' } },
  { id: 'rollup-plugin-url', app: 'rollup', build: `npx rollup -c rollup.url.config.js && ${COPY_HTML}`, serve: { static: 'dist' } },
  { id: 'rollup-copy', app: 'rollup', build: `npx rollup -c rollup.copy.config.js && ${COPY_HTML}`, serve: { static: 'dist' } },
  { id: 'esbuild-esm', app: 'esbuild', build: `npx esbuild main.js --bundle --format=esm --outdir=dist && ${COPY_HTML}`, serve: { static: 'dist' } },
  { id: 'esbuild-esm-copy', app: 'esbuild', build: `npx esbuild main.js --bundle --format=esm --outdir=dist && ${COPY_HTML} && cp node_modules/fake-sealed/sealed-document.html dist/`, serve: { static: 'dist' } },
  { id: 'esbuild-esm-splitting', app: 'esbuild', build: `npx esbuild main.js --bundle --format=esm --splitting --outdir=dist && ${COPY_HTML}`, serve: { static: 'dist' } },
  { id: 'bun-build', app: 'bun', build: `bun build main.js --outdir dist --target browser && ${COPY_HTML}`, serve: { static: 'dist' } },
  { id: 'bun-build-html', app: 'bun', build: 'bun build index.html --outdir dist', serve: { static: 'dist' } },
  { id: 'bun-dev', app: 'bun', serve: { cmd: 'bun index.html --port $PORT --hostname 127.0.0.1' } },
  { id: 'parcel-build', app: 'parcel', build: 'npx parcel build index.html --dist-dir dist --no-cache --no-source-maps', serve: { static: 'dist' } },
  { id: 'parcel-build-no-optimize', app: 'parcel', build: 'npx parcel build index.html --dist-dir dist --no-cache --no-source-maps --no-optimize', serve: { static: 'dist' } },
  { id: 'parcel-build-raw-transformer', app: 'parcel', build: 'npx parcel build index.html --dist-dir dist --no-cache --no-source-maps --config .parcelrc.raw', serve: { static: 'dist' } },
  { id: 'parcel-dev', app: 'parcel', serve: { cmd: 'npx parcel serve index.html --dist-dir dist --no-cache --host 127.0.0.1 --port $PORT --no-hmr' } },
  { id: 'parcel-build-htm', app: 'parcel', variant: 'htm', build: 'npx parcel build index.html --dist-dir dist --no-cache --no-source-maps', serve: { static: 'dist' } },
  { id: 'parcel-build-noext', app: 'parcel', variant: 'noext', build: 'npx parcel build index.html --dist-dir dist --no-cache --no-source-maps', serve: { static: 'dist' } },
  { id: 'next-dev', app: 'next', serve: { cmd: 'npx next dev --hostname 127.0.0.1 --port $PORT' } },
  { id: 'next-build', app: 'next', build: 'npx next build', serve: { cmd: 'npx next start --hostname 127.0.0.1 --port $PORT' } },
  { id: 'next-dev-webpack', app: 'next', serve: { cmd: 'npx next dev --webpack --hostname 127.0.0.1 --port $PORT' } },
  { id: 'next-build-webpack', app: 'next', build: 'npx next build --webpack', serve: { cmd: 'npx next start --hostname 127.0.0.1 --port $PORT' } },
];

// What a variant does to the installed copy of the package: another name for the same bytes.
const VARIANTS = {
  htm: { file: 'sealed-document.htm' },
  noext: { file: 'sealed-document' },
};

function sh(command, cwd, extraEnv = {}) {
  return spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv }, maxBuffer: 1 << 28 });
}

function logOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function packStandIn() {
  mkdirSync(WORK, { recursive: true });
  const packed = sh(`bun pm pack --destination ${WORK} --quiet`, join(HERE, 'fake-sealed'));
  if (packed.status !== 0) throw new Error(`pack failed: ${logOf(packed)}`);
}

function installApp(app) {
  const dir = join(WORK, app);
  mkdirSync(dir, { recursive: true });
  cpSync(join(HERE, 'apps', '_shared'), dir, { recursive: true });
  cpSync(join(HERE, 'apps', app), dir, { recursive: true });
  if (existsSync(join(dir, 'node_modules', '.installed'))) return dir;
  const installed = sh('npm install --no-audit --no-fund --no-package-lock', dir);
  if (installed.status !== 0) throw new Error(`install of ${app} failed: ${logOf(installed)}`);
  writeFileSync(join(dir, 'node_modules', '.installed'), '');
  return dir;
}

// The package as a registry install leaves it: a fresh copy of the tarball's content, in the case's variant.
function resetPackage(dir, variant) {
  const target = join(dir, 'node_modules', 'fake-sealed');
  rmSync(target, { recursive: true, force: true });
  const unpacked = sh(`mkdir -p ${target} && tar -xzf ${join(WORK, 'fake-sealed-1.0.0.tgz')} -C ${target} --strip-components=1`, dir);
  if (unpacked.status !== 0) throw new Error(`unpack failed: ${logOf(unpacked)}`);
  if (!variant) return;
  const { file } = VARIANTS[variant];
  renameSync(join(target, 'sealed-document.html'), join(target, file));
  const index = readFileSync(join(target, 'index.js'), 'utf8').replace('sealed-document.html', file);
  writeFileSync(join(target, 'index.js'), index);
  const manifestPath = join(target, 'package.json');
  const manifest = readFileSync(manifestPath, 'utf8').replaceAll('sealed-document.html', file);
  writeFileSync(manifestPath, manifest);
}

function cleanOutputs(dir) {
  for (const name of ['dist', '.next', '.parcel-cache', join('node_modules', '.vite'), join('node_modules', '.cache')]) {
    // a dev server just killed may still be writing: retry
    rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

function listFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(`${relative(root, path)} (${statSync(path).size} B)`);
    }
  }
  if (existsSync(root)) walk(root);
  return files;
}

function findOutputsNamed(dir, fragment) {
  const found = sh(`find . -path ./node_modules -prune -o -type f -iname '*${fragment}*' -print | head -20`, dir);
  return found.stdout.split('\n').filter(Boolean);
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return true;
    } catch {}
    await new Promise((done) => setTimeout(done, 300));
  }
  return false;
}

function measureInBrowser(pageUrl) {
  const measured = spawnSync('flock', [LOCK, 'node', join(HERE, 'measure.mjs'), pageUrl, EXPECTED_SHA], {
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS },
    timeout: 180000,
  });
  if (measured.status !== 0) return { error: `measure failed: ${logOf(measured)}` };
  return JSON.parse(measured.stdout);
}

async function runCase(entry, port) {
  const dir = installApp(entry.app);
  cleanOutputs(dir);
  resetPackage(dir, entry.variant);
  let log = '';
  let buildStatus = null;
  if (entry.build) {
    const built = sh(entry.build, dir, { PORT: String(port), NEXT_TELEMETRY_DISABLED: '1', CI: '1' });
    buildStatus = built.status;
    log += `$ ${entry.build}\n${logOf(built)}\n`;
  }
  let server;
  const serverLog = [];
  if (entry.serve.static) {
    server = spawn('node', [join(HERE, 'serve.mjs'), join(dir, entry.serve.static), String(port)]);
  } else {
    const cmd = entry.serve.cmd.replaceAll('$PORT', String(port));
    log += `$ ${cmd}\n`;
    server = spawn('bash', ['-c', cmd], { cwd: dir, env: { ...process.env, PORT: String(port), NEXT_TELEMETRY_DISABLED: '1', CI: '1' }, detached: true });
  }
  server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));
  const pageUrl = `http://127.0.0.1:${port}/`;
  let result;
  try {
    const up = await waitFor(pageUrl, 60000);
    result = up ? measureInBrowser(pageUrl) : { error: 'server did not come up' };
    // a dev server compiles on request: the first load may have been the compile
    if (up && !result.is200Html && !result.error) result = measureInBrowser(pageUrl);
  } finally {
    try {
      process.kill(-server.pid);
    } catch {
      server.kill();
    }
  }
  log += `--- server output\n${serverLog.join('')}`;
  const outputDir = entry.serve.static && entry.serve.static !== '.' ? entry.serve.static : entry.app === 'next' ? '.next/static' : 'dist';
  return {
    id: entry.id,
    app: entry.app,
    variant: entry.variant ?? null,
    build: entry.build ?? null,
    serve: entry.serve,
    buildExitCode: buildStatus,
    expectedSha256: EXPECTED_SHA,
    ...result,
    outputFiles: entry.id === 'cdn' ? [] : listFiles(join(dir, outputDir)).slice(0, 60),
    documentFilesInOutput: entry.id === 'cdn' ? [] : findOutputsNamed(dir, 'sealed-document'),
    log,
  };
}

function versionsOf(dir, names) {
  const versions = {};
  for (const name of names) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) versions[name] = JSON.parse(readFileSync(manifest, 'utf8')).version;
  }
  return versions;
}

async function main() {
  const wanted = process.argv.slice(2);
  const selected = wanted.length ? CASES.filter((entry) => wanted.includes(entry.id)) : CASES;
  mkdirSync(RESULTS, { recursive: true });
  packStandIn();
  const bunVersion = sh('bun --version', HERE).stdout.trim();
  for (const [index, entry] of CASES.entries()) {
    if (!selected.includes(entry)) continue;
    const result = await runCase(entry, 5170 + index);
    const dir = join(WORK, entry.app);
    result.versions = { bun: bunVersion, node: process.version, ...versionsOf(dir, ['vite', 'webpack', 'webpack-cli', 'webpack-dev-server', 'rollup', '@rollup/plugin-node-resolve', '@web/rollup-plugin-import-meta-assets', '@rollup/plugin-url', 'rollup-plugin-copy', 'esbuild', 'parcel', 'next', 'react']) };
    const { log, ...summary } = result;
    writeFileSync(join(RESULTS, `${entry.id}.json`), JSON.stringify(summary, null, 2) + '\n');
    writeFileSync(join(RESULTS, `${entry.id}.log`), log);
    console.log(`${entry.id}: ${(summary.url ?? summary.error).slice(0, 120)} status=${summary.status} html=${summary.is200Html} bytes=${summary.bytesEqual} frameBytes=${summary.iframe?.bytesEqual} sameOrigin=${summary.sameOrigin} name=${summary.fileName}`);
  }
}

await main();
