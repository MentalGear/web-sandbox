// Research 26: bundles worker-runtime.mjs with each quickjs-emscripten variant into one classic script per variant, in
// the scratch directory where the packages are installed (never in the repository's package.json):
//
//   INTERP_DIR=/path/to/scratch/interp bun docs/research/26_interpreter_logic_tier/build.mjs
//
// INTERP_DIR holds node_modules with quickjs-emscripten-core, @jitl/quickjs-wasmfile-release-sync and
// @jitl/quickjs-asmjs-mjs-release-sync at the versions the README names. Writes INTERP_DIR/build/: worker-wasm.js,
// worker-asmjs.js, quickjs.wasm, and sizes.json (raw, gzip -9 and brotli -q 11 of each file the worker needs).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.INTERP_DIR;
if (!dir) throw new Error('set INTERP_DIR to the scratch directory that holds the packages');
const out = path.join(dir, 'build');
mkdirSync(out, { recursive: true });
copyFileSync(path.join(here, 'worker-runtime.mjs'), path.join(dir, 'worker-runtime.mjs'));

const VARIANTS = {
    wasm: '@jitl/quickjs-wasmfile-release-sync',
    asmjs: '@jitl/quickjs-asmjs-mjs-release-sync',
};
for (const [name, pkg] of Object.entries(VARIANTS)) {
    const entry = path.join(dir, `entry-${name}.mjs`);
    writeFileSync(entry, `import variant from '${pkg}';\nimport { start } from './worker-runtime.mjs';\nstart(variant);\n`);
    for (const minify of [false, true]) {
        const result = await Bun.build({ entrypoints: [entry], format: 'iife', target: 'browser', minify, conditions: ['browser'], external: ['module'] });
        if (!result.success) throw new AggregateError(result.logs, `build of ${name} failed`);
        // a classic worker script has no import.meta, and a blob: URL is no base URL; the glue reads it only to locate
        // its .wasm, which it never fetches here (it is handed the bytes)
        const text = (await result.outputs[0].text()).replaceAll('import.meta.url', "'https://interp.invalid/'").replaceAll('import.meta', "({ url: 'https://interp.invalid/' })");
        writeFileSync(path.join(out, `worker-${name}${minify ? '.min' : ''}.js`), text);
    }
}
copyFileSync(path.join(dir, 'node_modules', VARIANTS.wasm, 'dist', 'emscripten-module.wasm'), path.join(out, 'quickjs.wasm'));

// Sizes: what a page would ship for the interpreter (the minified worker bundle, which includes the glue and the
// library's FFI, and the .wasm), each raw, gzip and brotli.
const sizes = {};
for (const file of ['worker-wasm.min.js', 'quickjs.wasm', 'worker-asmjs.min.js', 'worker-wasm.js', 'worker-asmjs.js']) {
    const bytes = readFileSync(path.join(out, file));
    sizes[file] = {
        raw: bytes.length,
        gzip: gzipSync(bytes, { level: 9 }).length,
        brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    };
}
writeFileSync(path.join(out, 'sizes.json'), JSON.stringify(sizes, null, 2));
console.log(`SIZES ${JSON.stringify(sizes)}`);
