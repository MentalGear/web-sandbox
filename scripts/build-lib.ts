/**
 * Bundles the package into dist/index.js (`bun run build:lib`, before the declarations are emitted), with the strict
 * view's bootstrap as one string literal (R2:C-8; in-sandbox-view.ts, viewBootstrapText). The text is built here,
 * once, from the sources, and handed to the bundler as the value of __WEB_SANDBOX_VIEW_BOOTSTRAP__, so the hash of the
 * script the element injects is a constant of the package: what viewScriptHash() returns in a build step is what the
 * browser computes, however a consumer bundles or minifies the package. scripts/smoke-package.sh checks both, through a
 * minified consumer bundle.
 *
 * Which build it writes is the build flag's (src/lib/build-flag.ts; ADR-009): the default build, whose entry is
 * src/index.ts and which has sealed mode alone, or with WEB_SANDBOX_NETWORK_MODES=1 the network build, whose entry
 * src/network.ts installs the network modes. Each build's bundle is made of the modules of that build and no other
 * (src/lib/build-modules.ts): the bundler reports the modules it kept code of, and a bundle that holds one outside the
 * build's list is not written. `--out <directory>` writes the bundle elsewhere than dist/ (the e2e server keeps the
 * network build beside the default one).
 */
import { rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BUILD_ENTRIES, buildFor, NETWORK_MODES_FLAG } from '../src/lib/build-flag';
import { modulesOf } from '../src/lib/build-modules';

const root = join(import.meta.dir, '..');
const build = buildFor(process.env[NETWORK_MODES_FLAG.env]);
const outArgument = process.argv.indexOf('--out');
const outdir = join(root, outArgument < 0 ? 'dist' : process.argv[outArgument + 1] ?? 'dist');
const entry = join(root, BUILD_ENTRIES[build]);

// The build's own modules, evaluated here (they need no DOM): the bootstrap's text is this build's, with the fetch
// bridge frame's part exactly when the entry installed the network modes.
await import(entry);
const { viewBootstrapHash, viewBootstrapText } = await import('../src/lib/in-sandbox-view');
const bootstrap = viewBootstrapText(); // throws if the text could not be hashed as written (A3)

const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    naming: 'index.js',
    target: 'browser',
    format: 'esm',
    metafile: true,
    define: { __WEB_SANDBOX_VIEW_BOOTSTRAP__: JSON.stringify(bootstrap) },
});
if (!result.success) {
    for (const message of result.logs) console.error(message);
    process.exit(1);
}

// The modules the bundle holds code of, as the bundler reports them: each must be one of this build's.
const bundled = Object.values(result.metafile!.outputs).flatMap(output => Object.entries(output.inputs));
const allowed = new Set<string>(modulesOf(build));
const foreign: string[] = [];
for (const [input, { bytesInOutput }] of bundled) {
    const file = relative(root, join(root, input));
    if (bytesInOutput > 0 && file.startsWith('src/') && !allowed.has(file)) foreign.push(file);
}
if (foreign.length > 0) {
    rmSync(join(outdir, 'index.js'), { force: true });
    console.error(`build-lib: the ${build} build's bundle holds code of ${foreign.join(', ')}, which ${foreign.length === 1 ? 'is' : 'are'} not of that build (src/lib/build-modules.ts): nothing was written`);
    process.exit(1);
}

// The bundle, imported here (it needs no DOM), hashes the very text built above.
const built = await import(join(outdir, 'index.js'));
if (built.viewScriptHash() !== viewBootstrapHash()) {
    console.error(`build-lib: ${relative(root, outdir)}/index.js hashes its view bootstrap as ${built.viewScriptHash()}, not ${viewBootstrapHash()}: the literal is missing`);
    process.exit(1);
}
console.log(`build-lib: ${relative(root, outdir)}/index.js, the ${build} build, view bootstrap ${viewBootstrapHash()} (${bootstrap.length} characters)`);
