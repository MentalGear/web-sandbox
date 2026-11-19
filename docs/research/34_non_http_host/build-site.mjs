// Writes research 34's fixture to site/ (not checked in; .gitignore): the host page, the served file F in its variants,
// the sibling resources the reach probe aims at, the library pages, and one unpacked MV3 extension per manifest variant.
// Needs today's default build in dist/ (`bun run build:lib` at the repository's root). From the repository root:
//
//   bun docs/research/34_non_http_host/build-site.mjs
//
// site/outside.txt                 a file one directory above the host page (file: only)
// site/app/                        the host page and everything beside it, served as is on file:, http: and Electron's app:
//   host.html, host.js             the host page (no inline script)
//   F.html                         the served file as the design draws it, with research 34's diagnostic script
//   F-nometa.html                  the same without its <meta> policy: what the browser's own rules give an opaque view
//   secret.txt, secret.png, secret.js, sub/secret.txt, war/secret.txt   what the reach probe reads
//   lib/index.js                   dist/index.js, today's default build, as a module
//   lib/ws-iife.js                 the same bundled as one classic script
//   lib-module.html, lib-classic.html, lib-run.mjs, lib-run-classic.js, lib-errors.js   the library baseline
// site/ext-<variant>/              site/app/ plus a manifest.json; site/ext-ids.json maps each variant to its id
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha } from '../28_served_topology/lib.mjs';
import { GUARD } from '../31_served_startup/fixture.mjs';
import {
    DIAG, HOST_HTML, LIB_CLASSIC_HTML, LIB_ERRORS_JS, LIB_IIFE_ENTRY, LIB_MODULE_HTML, LIB_RUN_CLASSIC_JS, LIB_RUN_MJS, PNG,
    hex, hostScript, servedFile,
} from './fixture.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(dir, '../../..');
const site = path.join(dir, 'site');
const app = path.join(site, 'app');

rmSync(site, { recursive: true, force: true });
mkdirSync(path.join(app, 'sub'), { recursive: true });
mkdirSync(path.join(app, 'war'), { recursive: true });
mkdirSync(path.join(app, 'lib'), { recursive: true });

const F = servedFile();
const FN = servedFile({ meta: false });
const put = (name, body) => writeFileSync(path.join(app, name), body);
put('F.html', F.html);
put('F-nometa.html', FN.html);
put('host.html', HOST_HTML);
put('host.js', hostScript({ 'F.html': hex(F.html), 'F-nometa.html': hex(FN.html) }));
put('secret.txt', 'SECRET-TXT-34 beside the host page');
put('secret.png', PNG);
put('secret.js', "self.__ws34secret = 'SECRET-JS-34';");
put('sub/secret.txt', 'SECRET-SUB-34 in a subdirectory');
put('war/secret.txt', 'SECRET-WAR-34 a web-accessible resource');
writeFileSync(path.join(site, 'outside.txt'), 'SECRET-OUTSIDE-34 one directory up');

// the library baseline: today's default build as shipped (a module), and as one classic script
cpSync(path.join(repo, 'dist/index.js'), path.join(app, 'lib/index.js'));
writeFileSync(path.join(app, 'lib/iife-entry.js'), LIB_IIFE_ENTRY);
const iife = await Bun.build({ entrypoints: [path.join(app, 'lib/iife-entry.js')], format: 'iife', target: 'browser' });
if (!iife.success) throw new Error(iife.logs.join('\n'));
put('lib/ws-iife.js', await iife.outputs[0].text());
rmSync(path.join(app, 'lib/iife-entry.js'));
put('lib-module.html', LIB_MODULE_HTML);
put('lib-classic.html', LIB_CLASSIC_HTML);
put('lib-run.mjs', LIB_RUN_MJS);
put('lib-run-classic.js', LIB_RUN_CLASSIC_JS);
put('lib-errors.js', LIB_ERRORS_JS);

// One unpacked MV3 extension per variant. The manifest's `key` fixes the id: the first 32 hex digits of the SHA-256 of
// the public key's DER, each digit mapped 0-f to a-p.
const SANDBOX_PAGES = ['F.html', 'F-nometa.html', 'lib-module.html', 'lib-classic.html'];
const VARIANTS = {
    // F is an ordinary extension resource; the extension's default policy (MV3: script-src 'self' 'wasm-unsafe-eval';
    // object-src 'self') applies to its pages
    normal: {},
    // F and war/ listed as web-accessible to every site
    war: { web_accessible_resources: [{ resources: ['F.html', 'F-nometa.html', 'war/*'], matches: ['<all_urls>'] }] },
    // F a sandbox page of the manifest, under the default sandbox policy
    sandbox: { sandbox: { pages: SANDBOX_PAGES } },
    // the same, with the narrowest sandbox policy a manifest can name: only the sandbox flags F is framed with
    'sandbox-csp': { sandbox: { pages: SANDBOX_PAGES }, content_security_policy: { sandbox: 'sandbox allow-scripts allow-forms' } },
    // an extension policy that admits F's and C's scripts by hash (whether Chromium loads an extension with one)
    hash: { content_security_policy: { extension_pages: `script-src 'self' ${sha(DIAG)} ${sha(GUARD)} ${F.cHash}; object-src 'self'` } },
};
const ids = {};
for (const [variant, extra] of Object.entries(VARIANTS)) {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const id = [...createHash('sha256').update(der).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
    const out = path.join(site, `ext-${variant}`);
    cpSync(app, out, { recursive: true });
    writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: `research 34 ${variant}`, version: '1', key: der.toString('base64'), ...extra }, null, 2));
    ids[variant] = id;
}
writeFileSync(path.join(site, 'ext-ids.json'), JSON.stringify(ids, null, 2));
console.log(JSON.stringify({ site, F: { bytes: F.html.length, digest: hex(F.html), cHash: F.cHash }, ids, iifeBytes: readFileSync(path.join(app, 'lib/ws-iife.js')).length }));
