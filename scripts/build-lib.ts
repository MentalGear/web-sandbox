/**
 * Bundles the package into dist/index.js (`bun run build:lib`, before tsc emits the declarations), with the strict view's
 * bootstrap as one string literal (review round 2, C-8; in-sandbox-view.ts, viewBootstrapText). The text is built here,
 * once, from the sources, and handed to the bundler as the value of __WEB_SANDBOX_VIEW_BOOTSTRAP__, so the hash of the
 * script the element injects is a constant of the package: what viewScriptHash() returns in a build step is what the
 * browser computes, however a consumer bundles or minifies the package. scripts/smoke-package.sh checks both, through a
 * minified consumer bundle.
 */
import { join } from 'node:path';
import { viewBootstrapText, viewScriptHash } from '../src/lib/in-sandbox-view';

const root = join(import.meta.dir, '..');
const bootstrap = viewBootstrapText(); // throws if the text could not be hashed as written (A3)

const result = await Bun.build({
    entrypoints: [join(root, 'src', 'index.ts')],
    outdir: join(root, 'dist'),
    target: 'browser',
    format: 'esm',
    define: { __WEB_SANDBOX_VIEW_BOOTSTRAP__: JSON.stringify(bootstrap) },
});
if (!result.success) {
    for (const message of result.logs) console.error(message);
    process.exit(1);
}
// The bundle, imported here (it needs no DOM), hashes the very text built above.
const built = await import(join(root, 'dist', 'index.js'));
if (built.viewScriptHash() !== viewScriptHash()) {
    console.error(`build-lib: dist/index.js hashes its view bootstrap as ${built.viewScriptHash()}, not ${viewScriptHash()}: the literal is missing`);
    process.exit(1);
}
console.log(`build-lib: dist/index.js, view bootstrap ${viewScriptHash()} (${bootstrap.length} characters)`);
