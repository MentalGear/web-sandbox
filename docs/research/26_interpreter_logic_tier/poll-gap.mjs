// Research 26, Q2 side measurement: the interrupt watchdog against a loop of heavy native operations, in Bun's main
// thread (JavaScriptCore). The handler returns true from the first time it is called after a 1 s deadline; QuickJS
// calls it only once per 10 000 poll points (about 5 000 turns of a loop that makes one native call per turn), so a loop
// of 0.6 s operations is not interrupted for about 5 000 × 0.6 s. The evaluation blocks the thread, so the run is
// bounded from outside (`timeout 60`): no "returned" line within it means the watchdog had not fired. It resolves the packages from the directory it sits in, so copy it into INTERP_DIR first:
//   cp docs/research/26_interpreter_logic_tier/poll-gap.mjs $INTERP_DIR/ && timeout 60 bun $INTERP_DIR/poll-gap.mjs; echo exit $?
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';

const Q = await newQuickJSWASMModuleFromVariant(variant);
const rt = Q.newRuntime();
rt.setMemoryLimit(256 * 1048576);
const t0 = performance.now();
const deadline = t0 + 1000;
let calls = 0;
rt.setInterruptHandler(() => { calls++; return performance.now() > deadline; });
const vm = rt.newContext();
console.log(`POLLGAP start ${JSON.stringify({ op: "'x'.repeat(2e8) in an endless loop", deadlineMs: 1000, at: new Date().toISOString() })}`);
const r = vm.evalCode("globalThis.n = 0; for (;;) { n++; 'x'.repeat(2e8).length; }");
console.log(`POLLGAP returned ${JSON.stringify({ afterMs: Math.round(performance.now() - t0), turns: vm.dump(vm.getProp(vm.global, 'n')), calls, error: r.error ? vm.dump(r.error).message : null })}`);
