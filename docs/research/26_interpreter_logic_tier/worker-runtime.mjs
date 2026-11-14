// Research 26: what runs in the blob worker, around the interpreter. build.mjs bundles it with one quickjs-emscripten
// variant into one classic script (an IIFE), which the view turns into a `blob:` worker. No library code: the worker
// here is the probe's own, and it keeps its platform postMessage to report.
//
// The worker gets one message, { wasm: ArrayBuffer | null, job }, runs the job and posts { type, ... } messages. The
// content (the code the interpreter runs) is always a string evaluated inside the interpreter; nothing the content
// writes runs as native code.
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';

const MiB = 1048576;
const now = () => performance.now();
const post = (type, data = {}) => self.postMessage({ type, ...data });
const describe = (error) => (error && typeof error === 'object' ? `${error.name}: ${String(error.message).slice(0, 200)}` : String(error).slice(0, 200));
const round = (ms) => Math.round(ms * 100) / 100;

const violations = [];
self.addEventListener('securitypolicyviolation', (event) => violations.push(`${event.violatedDirective} ${event.blockedURI}`));

/**
 * The content's single operations (Q2): `setup` runs once, `step` is the operation that runs inside the interpreter's
 * native code. Sizes are picked to fit a 256 MiB interpreter memory limit.
 */
export const OPS = {
    loop: { setup: '', step: '' },
    regex: { setup: "globalThis.s = 'a'.repeat(40) + 'b';", step: '/^(a+)+$/.test(s);' },
    sortArray: { setup: 'globalThis.a = []; for (let i = 0; i < 3e6; i++) a.push((i * 7919) % 1000003);', step: 'globalThis.b = a.slice(); b.sort();' },
    sortTyped: { setup: 'globalThis.f = new Float64Array(1e7); for (let i = 0; i < f.length; i++) f[i] = (i * 7919) % 1000003;', step: 'globalThis.g = f.slice(); g.sort();' },
    stringify: { setup: "globalThis.o = []; for (let i = 0; i < 1e6; i++) o.push({ a: i, b: 'xxxxxxxxxx', c: [1, 2, 3] });", step: 'JSON.stringify(o).length;' },
    parse: { setup: "globalThis.j = JSON.stringify(Array.from({ length: 1e6 }, (_, i) => ({ a: i, b: 'xxxxxxxxxx', c: [1, 2, 3] })));", step: 'JSON.parse(j).length;' },
    repeat: { setup: '', step: "'x'.repeat(2e8).length;" },
    join: { setup: "globalThis.a = new Array(2e7).fill('ab');", step: "a.join(',').length;" },
    bigintToString: { setup: 'globalThis.x = (1n << 1048000n) - 1n;', step: 'x.toString().length;' },
};

let baseVariant = null;

/** A fresh interpreter module (a new Emscripten instance and memory). */
function makeModule(init, extra = {}) {
    const options = {};
    if (init.wasm && !extra.wasmModule) options.wasmBinary = init.wasm;
    if (extra.wasmModule) options.wasmModule = extra.wasmModule;
    if (extra.wasmMemory) options.wasmMemory = extra.wasmMemory;
    const variant = Object.keys(options).length ? newVariant(baseVariant, options) : baseVariant;
    return newQuickJSWASMModuleFromVariant(variant);
}

/** Evaluates `code` and returns { value } or { error } as plain data, disposing the handles. */
function evaluate(vm, code) {
    const result = vm.evalCode(code);
    if (result.error) {
        const error = vm.dump(result.error);
        result.error.dispose();
        return { error: typeof error === 'object' && error ? `${error.name}: ${String(error.message).slice(0, 160)}` : String(error).slice(0, 160) };
    }
    const value = vm.dump(result.value);
    result.value.dispose();
    return { value };
}

function runtimeWith(Q, { mem = 256, stack = MiB } = {}) {
    const rt = Q.newRuntime();
    if (mem) rt.setMemoryLimit(mem * MiB);
    if (stack) rt.setMaxStackSize(stack);
    return rt;
}

// ---- jobs ----------------------------------------------------------------------------------------------------------

const JOBS = {
    /** Q1: does a module load, instantiate and evaluate under the policies in force? */
    async load(init) {
        const out = {};
        const t0 = now();
        try {
            const Q = await makeModule(init);
            const vm = Q.newContext();
            out.result = evaluate(vm, '6 * 7').value;
            out.ms = round(now() - t0);
        } catch (error) {
            out.error = describe(error);
        }
        try { out.nativeEval = `ran ${globalThis['ev' + 'al']('1 + 1')}`; } catch (error) { out.nativeEval = `refused ${error.name}`; }
        await new Promise((resolve) => setTimeout(resolve, 100));
        out.workerViolations = violations.slice();
        post('done', out);
    },

    /** Q2: content loops on one operation for ever; the host then terminates the worker or removes the frame. */
    async stop(init, { op, wired }) {
        const Q = await makeModule(init);
        const rt = runtimeWith(Q);
        let calls = 0;
        if (wired) rt.setInterruptHandler(() => { calls++; return false; });
        const vm = rt.newContext();
        const setup = evaluate(vm, OPS[op].setup);
        if (setup.error) return post('done', { error: `setup ${setup.error}` });
        post('spinning', { calls });
        const end = evaluate(vm, `for (;;) { ${OPS[op].step} }`);
        post('done', { ended: end, calls });
    },

    /**
     * Q2: the interpreter's own interrupt as a watchdog (no terminate()): the handler returns true once a deadline has
     * passed; how long after the deadline does control come back? Also each operation's duration, alone, unwired.
     */
    async watchdog(init, { op, deadlineMs = 1000, reps = 3 }) {
        const Q = await makeModule(init);
        const rt = runtimeWith(Q);
        let deadline = Infinity;
        let calls = 0;
        rt.setInterruptHandler(() => { calls++; return now() > deadline; });
        const vm = rt.newContext();
        const setup = evaluate(vm, OPS[op].setup);
        if (setup.error) return post('done', { error: `setup ${setup.error}` });
        const durations = [];
        for (let i = 0; i < reps && op !== 'loop' && op !== 'regex'; i++) {
            const t0 = now();
            const r = evaluate(vm, OPS[op].step);
            durations.push(round(now() - t0));
            if (r.error) return post('done', { error: `step ${r.error}` });
        }
        const overshoots = [];
        let interrupted = '';
        for (let i = 0; i < reps; i++) {
            calls = 0;
            deadline = now() + deadlineMs;
            const r = evaluate(vm, `for (;;) { ${OPS[op].step} }`);
            overshoots.push(round(now() - deadline));
            deadline = Infinity;
            interrupted = r.error ?? `returned ${r.value}`;
        }
        const after = evaluate(vm, '1 + 1');
        post('done', { op, durations, overshoots, interrupted, usableAfter: after.value === 2, calls });
    },

    /** Q3: content allocates past a limit. What does the content see, and the worker? */
    async memory(init, { limitMiB, wasmMaxMiB, content }) {
        const out = { limitMiB, wasmMaxMiB, content };
        const memory = wasmMaxMiB ? new WebAssembly.Memory({ initial: 256, maximum: wasmMaxMiB * 16 }) : undefined;
        let Q;
        try {
            Q = await makeModule(init, { wasmMemory: memory });
        } catch (error) { out.moduleError = describe(error); return post('done', out); }
        const rt = Q.newRuntime();
        if (limitMiB) rt.setMemoryLimit(limitMiB * MiB);
        rt.setMaxStackSize(MiB);
        const vm = rt.newContext();
        const source = {
            arrays: "try { const keep = []; for (;;) keep.push(new Array(1e5).fill(1.5)); } catch (e) { 'caught ' + e.name + ': ' + e.message }",
            string: "try { const keep = []; for (let n = 1e6; ; n *= 2) keep.push('x'.repeat(n)); } catch (e) { 'caught ' + e.name + ': ' + e.message }",
            uncaught: 'const keep = []; for (;;) keep.push(new Array(1e5).fill(1.5));',
            small: "'nothing allocated'",
        }[content];
        const t0 = now();
        try {
            out.result = evaluate(vm, source);
        } catch (error) {
            out.workerThrew = describe(error);
        }
        out.ms = round(now() - t0);
        try { out.usableAfter = evaluate(vm, '[1, 2, 3].map(x => x * 2).join()'); } catch (error) { out.usableAfter = `threw ${describe(error)}`; }
        try { const vm2 = Q.newContext(); out.newContextAfter = evaluate(vm2, '40 + 2'); } catch (error) { out.newContextAfter = `threw ${describe(error)}`; }
        try { const Q2 = await makeModule(init); out.newModuleAfter = evaluate(Q2.newContext(), '40 + 2'); } catch (error) { out.newModuleAfter = `threw ${describe(error)}`; }
        if (memory) out.wasmMemoryMiB = memory.buffer.byteLength / MiB;
        post('done', out);
    },

    /** Q4: startup, cold and warm, and the speed of the same source here and in the interpreter. */
    async cost(init, { bench, app, turns = 20 }) {
        const out = { startup: {}, speed: {}, app: {} };
        // cold: from the bytes to a context that has evaluated something
        let t0 = now();
        const Q = await makeModule(init);
        const rt = runtimeWith(Q);
        const vm = rt.newContext();
        evaluate(vm, '1');
        out.startup.coldMs = round(now() - t0);
        // warm: the compiled module kept, a new instance from it (wasm only), and a new context in a live runtime
        if (init.wasm) {
            t0 = now();
            const compiled = await WebAssembly.compile(init.wasm);
            out.startup.compileMs = round(now() - t0);
            const warm = [];
            for (let i = 0; i < 3; i++) {
                t0 = now();
                const Qw = await makeModule(init, { wasmModule: compiled });
                evaluate(Qw.newContext(), '1');
                warm.push(round(now() - t0));
            }
            out.startup.warmInstanceMs = warm;
        } else {
            const warm = [];
            for (let i = 0; i < 3; i++) {
                t0 = now();
                const Qw = await makeModule(init);
                evaluate(Qw.newContext(), '1');
                warm.push(round(now() - t0));
            }
            out.startup.warmInstanceMs = warm;
        }
        const contexts = [];
        for (let i = 0; i < 3; i++) {
            t0 = now();
            const c = rt.newContext();
            evaluate(c, '1');
            contexts.push(round(now() - t0));
            c.dispose();
        }
        out.startup.newContextMs = contexts;
        // speed: the same function source, natively (self.NATIVE, appended to this script by the host) and in the interpreter
        for (const [name, source] of Object.entries(bench)) {
            evaluate(vm, `globalThis.bench_${name} = ${source};`);
            t0 = now();
            const native = self.NATIVE[name]();
            const nativeMs = now() - t0;
            t0 = now();
            const interp = evaluate(vm, `bench_${name}()`);
            const interpMs = now() - t0;
            out.speed[name] = { nativeMs: round(nativeMs), interpMs: round(interpMs), same: interp.value === native, ratio: round(interpMs / nativeMs) };
        }
        // one "user adds a todo" turn of examples/sealed-app/app.js, natively and in the interpreter
        out.app.native = await nativeApp(turns);
        out.app.interp = await interpApp(rt, app, turns);
        post('done', out);
    },

    /** Q5: a flood of unhandled rejections inside the interpreter, driven by the worker's own timer (no host function). */
    async flood(init, { kind }) {
        if (kind === 'native') {
            const text = 'x'.repeat(2 ** 24);
            setInterval(() => { Promise.reject(new Error(text)); Promise.reject(new Error(text)); }, 0);
            return post('flooding', { kind });
        }
        const Q = await makeModule(init);
        const rt = runtimeWith(Q);
        const vm = rt.newContext();
        const setup = kind === 'interp-fresh'
            ? "globalThis.tick = () => { Promise.reject(new Error('x'.repeat(2 ** 24))); Promise.reject(new Error('x'.repeat(2 ** 24))); };"
            : "globalThis.text = 'x'.repeat(2 ** 24); globalThis.tick = () => { Promise.reject(new Error(text)); Promise.reject(new Error(text)); };";
        evaluate(vm, setup);
        let ticks = 0;
        let errors = 0;
        setInterval(() => {
            const r = evaluate(vm, 'tick()');
            if (r.error) errors++;
            rt.executePendingJobs();
            ticks++;
        }, 0);
        setTimeout(() => post('flood-progress', { ticks, errors }), 3000);
        post('flooding', { kind });
    },

    /** Q6 and Q7: what the content can reach from inside the interpreter, with no host function installed. */
    async reach(init, { allowlist, control = true }) {
        const Q = await makeModule(init);
        const rt = runtimeWith(Q);
        const vm = rt.newContext();
        const out = {};
        out.globals = evaluate(vm, `(() => { const names = []; for (let o = globalThis; o; o = Object.getPrototypeOf(o)) names.push(...Object.getOwnPropertyNames(o)); return names.sort(); })()`).value;
        const probes = ['navigator', 'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'postMessage', 'onmessage', 'self', 'window', 'location',
            'setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame', 'console', 'performance', 'crypto', 'TextEncoder', 'TextDecoder',
            'structuredClone', 'Intl', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'OffscreenCanvas', 'Blob', 'URL', 'atob', 'require', 'process',
            'std', 'os', 'print', 'scriptArgs', 'Worker', 'indexedDB', 'caches', 'BroadcastChannel', 'MessageChannel'];
        out.typeofs = evaluate(vm, `(${JSON.stringify(probes)}).map(n => n + ':' + typeof globalThis[n])`).value;
        out.evalInside = evaluate(vm, "eval('1 + 1') + ',' + new Function('return 3')() + ',' + (typeof Function('return this')().navigator)");
        out.constructorEscape = evaluate(vm, "(() => {}).constructor('return typeof navigator + typeof fetch + typeof postMessage')()");
        out.errorStack = evaluate(vm, 'new Error("x").stack');
        // a dynamic import, with no module loader given to the runtime
        evaluate(vm, "globalThis.imp = 'pending'; import('https://example.invalid/x.js').then(() => { imp = 'loaded'; }, (e) => { imp = 'rejected ' + e.name + ': ' + e.message; }); 0");
        rt.executePendingJobs();
        out.dynamicImport = evaluate(vm, 'imp').value;
        out.staticImportScript = evaluate(vm, "import x from 'https://example.invalid/x.js';");
        // clocks and randomness the content has without any host function
        out.dateNowStepMs = evaluate(vm, "(() => { let smallest = Infinity; for (let k = 0; k < 20; k++) { const t0 = Date.now(); let t1 = t0; while (t1 === t0) t1 = Date.now(); const step = t1 - t0; if (step < smallest) smallest = step; } return smallest; })()");
        out.mathRandom = evaluate(vm, '[Math.random(), Math.random()].map(x => x.toFixed(6)).join()');
        out.newDate = evaluate(vm, 'typeof new Date().getTimezoneOffset()');
        // the allowlist of the library's sealed worker, name by name: what the interpreter has of it
        out.allowlistPresent = evaluate(vm, `(${JSON.stringify(allowlist)}).filter(n => n in globalThis)`).value;
        out.allowlistAbsent = evaluate(vm, `(${JSON.stringify(allowlist)}).filter(n => !(n in globalThis))`).value;
        // the same reached through native eval in this worker: the positive control for the policy (refused, reported)
        if (control) { try { out.nativeEvalControl = `ran ${globalThis['ev' + 'al']('1')}`; } catch (error) { out.nativeEvalControl = `refused ${error.name}`; } }
        await new Promise((resolve) => setTimeout(resolve, 200));
        out.workerViolations = violations.slice();
        post('done', out);
    },

    /** The boundary: what crosses when content hands a host function a huge string, a cyclic object, getters, a Proxy. */
    async boundary(init) {
        const Q = await makeModule(init);
        const rt = runtimeWith(Q, { mem: 512 });
        let deadline = Infinity;
        rt.setInterruptHandler(() => now() > deadline);
        const vm = rt.newContext();
        const out = {};
        let seen = null;
        const take = vm.newFunction('take', (handle) => {
            const t0 = now();
            try {
                const type = vm.typeof(handle);
                const value = type === 'string' ? vm.getString(handle) : vm.dump(handle);
                seen = { type, ms: round(now() - t0), kind: typeof value, size: typeof value === 'string' ? value.length : JSON.stringify(value ?? null)?.length, sample: (typeof value === 'string' ? value : JSON.stringify(value ?? null)).slice(0, 60) };
            } catch (error) {
                seen = { ms: round(now() - t0), threw: describe(error) };
            }
        });
        vm.setProp(vm.global, 'take', take);
        take.dispose();
        const cases = {
            hugeString: "take('x'.repeat(1e8))",
            hugeUnicode: "take('\\u00e9'.repeat(5e7))",
            cyclic: 'const c = { a: 1 }; c.self = c; take(c)',
            getters: 'globalThis.side = 0; take({ get a() { side++; return 1; }, get b() { side++; return 2; } })',
            proxy: "globalThis.trapped = 0; take(new Proxy({ a: 1 }, { get(t, k) { trapped++; return t[k]; }, ownKeys(t) { trapped++; return Reflect.ownKeys(t); }, getOwnPropertyDescriptor(t, k) { trapped++; return Reflect.getOwnPropertyDescriptor(t, k); } }))",
            toJSON: "take({ toJSON() { return 'y'.repeat(5e7); } })",
            getterLoops: 'take({ get a() { for (;;) {} } })',
        };
        for (const [name, code] of Object.entries(cases)) {
            seen = null;
            deadline = name === 'getterLoops' ? now() + 1000 : Infinity;
            const t0 = now();
            const r = evaluate(vm, code);
            deadline = Infinity;
            out[name] = { host: seen, evalMs: round(now() - t0), eval: r.error ?? 'ok' };
        }
        out.getterSideEffects = evaluate(vm, 'side').value;
        out.proxyTraps = evaluate(vm, 'trapped').value;
        post('done', out);
    },
};

// ---- the example app, natively and in the interpreter (Q4) ------------------------------------------------------------

const seedTodos = (n) => Array.from({ length: n }, (_, i) => ({ text: `todo ${i}`, done: i % 3 === 0 }));

/** app.js with stubbed sandboxView, bridge and sandboxFiles, in this worker (self.APP_NATIVE is appended by the host). */
async function nativeApp(turns) {
    let sink = 0;
    const handlers = new Map();
    const exposed = new Map();
    let saved = null;
    const sandboxView = {
        render: (html) => { sink += html.length; },
        text: (_id, text) => { sink += String(text).length; },
        set: () => { sink++; },
        on: (type, id, handler) => handlers.set(`${type}:${id}`, handler),
    };
    const bridge = {
        expose: (name, fn) => exposed.set(name, fn),
        call: (name, data) => { sink += JSON.stringify(data).length; if (name === 'save') saved?.(); return Promise.resolve(); },
    };
    const sandboxFiles = { write: async (_path, blob) => { sink += blob.size; } };
    self.APP_NATIVE(sandboxView, bridge, sandboxFiles);
    await exposed.get('load')(seedTodos(100));
    const times = [];
    for (let i = 0; i < turns; i++) {
        const done = new Promise((resolve) => { saved = resolve; });
        const t0 = now();
        handlers.get('submit:add')({ form: [['text', `buy milk ${i}`]] });
        await done;
        times.push(round(now() - t0));
    }
    return { times, sink };
}

/**
 * The same app.js source evaluated in the interpreter. The library would have to supply every platform function it
 * uses as a host function; here: sandboxView, bridge, sandboxFiles (stubs as above), and OffscreenCanvas, a shim
 * inside the interpreter whose drawing calls go to a real OffscreenCanvas in this worker.
 */
async function interpApp(rt, appSource, turns) {
    const vm = rt.newContext();
    let sink = 0;
    let saved = null;
    const handlers = new Map();
    const exposed = new Map();
    const canvases = [];
    const blobs = [];
    const pending = new Set();
    const fn = (name, impl) => { const h = vm.newFunction(name, impl); vm.setProp(vm.global, name, h); h.dispose(); };
    fn('__render', (html) => { sink += vm.getString(html).length; });
    fn('__text', (_id, text) => { sink += vm.getString(text).length; });
    fn('__set', () => { sink++; });
    fn('__on', (type, id, handler) => { handlers.set(`${vm.getString(type)}:${vm.getString(id)}`, handler.dup()); });
    fn('__expose', (name, f) => { exposed.set(vm.getString(name), f.dup()); });
    fn('__call', (name, data) => {
        const n = vm.getString(name);
        sink += JSON.stringify(vm.dump(data)).length;
        if (n === 'save') saved?.();
        const d = vm.newPromise();
        d.resolve(vm.undefined);
        d.settled.then(() => rt.executePendingJobs());
        return d.handle;
    });
    fn('__canvas', (w, h) => { canvases.push(new OffscreenCanvas(vm.getNumber(w), vm.getNumber(h))); return vm.newNumber(canvases.length - 1); });
    fn('__ctx', (id, op, a, b, c, d) => {
        const context = canvases[vm.getNumber(id)].getContext('2d');
        const name = vm.getString(op);
        if (name === 'fillStyle') context.fillStyle = vm.getString(a);
        else context.fillRect(vm.getNumber(a), vm.getNumber(b), vm.getNumber(c), vm.getNumber(d));
    });
    fn('__blob', (id) => {
        const d = vm.newPromise();
        const job = canvases[vm.getNumber(id)].convertToBlob({ type: 'image/png' }).then((blob) => {
            blobs.push(blob);
            const n = vm.newNumber(blobs.length - 1);
            d.resolve(n);
            n.dispose();
            rt.executePendingJobs();
        });
        pending.add(job);
        job.finally(() => pending.delete(job));
        return d.handle;
    });
    fn('__write', (_path, id) => {
        sink += blobs[vm.getNumber(id)].size;
        const d = vm.newPromise();
        d.resolve(vm.undefined);
        d.settled.then(() => rt.executePendingJobs());
        return d.handle;
    });
    const prelude = `
      const sandboxView = { render: (h, id) => __render(h, id), text: (id, t) => __text(id, String(t)), set: (id, p) => __set(id), on: (t, id, f) => __on(t, id, f) };
      const bridge = { expose: (n, f) => __expose(n, f), call: (n, d) => __call(n, d) };
      const sandboxFiles = { write: (p, b) => __write(p, b.__id) };
      class OffscreenCanvas {
        constructor(w, h) { this.id = __canvas(w, h); }
        getContext() { const id = this.id; return { set fillStyle(v) { __ctx(id, 'fillStyle', v); }, fillRect(x, y, w, h) { __ctx(id, 'fillRect', x, y, w, h); } }; }
        convertToBlob() { return __blob(this.id).then((n) => ({ __id: n })); }
      }
    `;
    const loaded = evaluate(vm, prelude + appSource);
    if (loaded.error) return { error: loaded.error };
    const call = async (f, arg) => {
        const r = vm.callFunction(f, vm.undefined, arg);
        if (r.error) { const e = vm.dump(r.error); r.error.dispose(); throw new Error(JSON.stringify(e)); }
        r.value.dispose();
        rt.executePendingJobs();
    };
    const seed = vm.unwrapResult(vm.evalCode(`(${JSON.stringify(seedTodos(100))})`));
    await call(exposed.get('load'), seed);
    seed.dispose();
    while (pending.size) await Promise.all([...pending]);
    const times = [];
    for (let i = 0; i < turns; i++) {
        const done = new Promise((resolve) => { saved = resolve; });
        const t0 = now();
        const event = vm.unwrapResult(vm.evalCode(`({ form: [['text', 'buy milk ${i}']] })`));
        await call(handlers.get('submit:add'), event);
        event.dispose();
        await done;
        times.push(round(now() - t0));
        while (pending.size) await Promise.all([...pending]);
    }
    return { times, sink };
}

export function start(variant) {
    baseVariant = variant;
    self.addEventListener('message', (event) => {
        const { job } = event.data;
        const run = JOBS[job.name];
        if (!run) return post('done', { error: `no job ${job.name}` });
        Promise.resolve().then(() => run(event.data, job)).catch((error) => post('done', { error: describe(error), fatal: true }));
    }, { once: true });
    post('worker-started');
}
