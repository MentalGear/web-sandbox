// Research 26, Q2 side measurement: counts the calls from the interpreter's wasm into its JavaScript imports (the
// Emscripten glue's functions: memory growth, the clock, …) during each operation, in Bun's main thread (JavaScriptCore,
// the engine WebKit uses). It resolves the packages from the directory it sits in, so copy it into INTERP_DIR first:
//   cp docs/research/26_interpreter_logic_tier/import-calls.mjs $INTERP_DIR/ && bun $INTERP_DIR/import-calls.mjs '<ops json>'
// (the JSON used is in the README's Rerun section). Prints, per operation and turn, its time and the import calls made.
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
const counts = {};
const original = WebAssembly.instantiate;
WebAssembly.instantiate = function (bytes, imports) {
    for (const [mod, fns] of Object.entries(imports ?? {})) for (const [name, fn] of Object.entries(fns)) {
        if (typeof fn !== 'function') continue;
        const key = `${mod}.${name}`;
        fns[name] = function (...args) { counts[key] = (counts[key] ?? 0) + 1; return fn.apply(this, args); };
        Object.defineProperty(fns[name], 'source', { value: fn.toString().slice(0, 80) });
    }
    globalThis.__imports = imports;
    return original.call(this, bytes, imports);
};
const Q = await newQuickJSWASMModuleFromVariant(variant);
const rt = Q.newRuntime(); rt.setMemoryLimit(256 * 1048576); rt.setMaxStackSize(1048576);
const vm = rt.newContext();
const OPS = JSON.parse(process.argv[2]);
for (const [name, [setup, step]] of Object.entries(OPS)) {
    vm.evalCode(setup + ";0"); console.log(name, "setup calls", JSON.stringify(counts), "wrapped", !!globalThis.__imports);
    for (let i = 0; i < 3; i++) {
        for (const k in counts) delete counts[k];
        const t0 = performance.now();
        const r = vm.evalCode(step + ';0'); r.dispose?.();
        const named = Object.fromEntries(Object.entries(counts).map(([k, v]) => [`${k} ${globalThis.__imports.a[k.split('.')[1]].source.replace(/\s+/g, ' ')}`, v]));
        console.log(name, 'turn', i, Math.round(performance.now() - t0), 'ms', JSON.stringify(named));
    }
}
