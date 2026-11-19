// Why an extension variant does not load: Chromium with that one unpacked extension and its log on stderr, then a
// navigation to its host page. From the repository root, after build-site.mjs:
//
//   bun docs/research/34_non_http_host/probe-ext-load.mjs <variant> 2> log.txt
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { emit } from '../28_served_topology/lib.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const variant = process.argv[2] ?? 'hash';
const ids = JSON.parse(readFileSync(path.join(dir, 'site/ext-ids.json'), 'utf8'));
const ext = path.join(dir, `site/ext-${variant}`);
const profile = mkdtempSync(path.join(tmpdir(), 'r34-load-'));
const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--enable-logging=stderr', '--v=0'],
});
const page = await context.newPage();
const url = `chrome-extension://${ids[variant]}/host.html`;
let result;
try { await page.goto(url); result = 'loaded'; } catch (e) { result = String(e).split('\n')[0]; }
emit('r34l.load', { variant, manifestCsp: JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8')).content_security_policy ?? null, url, result });
await context.close();
rmSync(profile, { recursive: true, force: true });
process.exit(0);
