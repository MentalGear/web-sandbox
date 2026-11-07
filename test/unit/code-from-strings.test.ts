import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ABSENT_COMPILERS, CODE_FROM_STRING_REFUSAL, CODE_FROM_STRING_SINKS, FUNCTION_KINDS_SOURCE, REFUSED_GLOBALS, REFUSED_TIMERS, refuseCodeFromStrings } from '@src/lib/code-from-strings';
import { STRICT_WORKER_GLOBALS } from '@src/lib/worker-globals';
import { inStrictWorker, viewBootstrapHash } from '@src/lib/in-sandbox-view';
import { SEALED_FILE_KINDS, sealedViewPolicy } from '@src/lib/csp/csp-generator';

/**
 * The code-from-string sinks of the guest's worker (code-from-strings.ts; S74, class A: INHERITED_CONTEXT.cspPolicyText,
 * cspReporting; BD6:ISO-1). Every way the language makes a function from a string is a `constructor` of a function kind's
 * prototype, or `eval`; the worker adds its timers. These tests enumerate the kinds from the language itself and check
 * them against the prelude's list, so a kind the language gains is classified before it ships; and they run the prelude in
 * a realm whose platform refuses every string (`codeGeneration.strings: false`), so a sink that still reached the platform
 * would throw the platform's error and not the library's.
 */

// Every syntax that makes a function, of every kind the language has.
const FUNCTION_SYNTAXES = [
    'function () {}', '() => {}', 'async function () {}', 'async () => {}', 'function* () {}', 'async function* () {}',
    'class {}', '({ m() {} }).m', '({ async m() {} }).m', '({ *m() {} }).m', '({ async *m() {} }).m',
    "Object.getOwnPropertyDescriptor({ get x() { return 1; } }, 'x').get", "Object.getOwnPropertyDescriptor({ set x(v) {} }, 'x').set",
    '(function () {}).bind(null)', '(async () => {}).bind(null)', 'new Proxy(function () {}, {})', '(class { static m() {} }).m',
    '(class { static async *m() {} }).m', 'Math.max', 'Promise.resolve', 'Array.prototype[Symbol.iterator]',
];

/**
 * A realm whose platform compiles no string, with timers of its own on the global object's prototype chain, as a worker's
 * are on WorkerGlobalScope.prototype; `calls` reads what they were called with.
 */
function stringlessRealm() {
    const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
    const run = <T>(code: string): T => vm.runInContext(code, context) as T;
    run(`(() => {
        const calls = [];
        const scope = Object.create(Object.getPrototypeOf(globalThis));
        scope.setTimeout = function setTimeout(...args) { calls.push(['setTimeout', ...args]); return 1; };
        scope.setInterval = function setInterval(...args) { calls.push(['setInterval', ...args]); return 2; };
        Object.setPrototypeOf(globalThis, scope);
        Object.defineProperty(globalThis, '__calls', { value: calls });
    })()`);
    return { context, run, calls: () => run<unknown[][]>('[...__calls]') };
}

const prelude = () => `(${refuseCodeFromStrings.toString()})(globalThis, ${FUNCTION_KINDS_SOURCE}, ${JSON.stringify(REFUSED_GLOBALS)}, ${JSON.stringify(REFUSED_TIMERS)}, ${JSON.stringify(CODE_FROM_STRING_REFUSAL)});`;

describe('the function kinds of the language are the prelude\'s', () => {
    it('every syntax that makes a function makes one of the kinds FUNCTION_KINDS_SOURCE names, and every kind is made by one', () => {
        const { run } = stringlessRealm();
        const prelude = run<object[]>(`${FUNCTION_KINDS_SOURCE}.map(Object.getPrototypeOf)`);
        const fromSyntax = run<object[]>(`[${FUNCTION_SYNTAXES.join(', ')}].map(Object.getPrototypeOf)`);
        const kinds = [...new Set(fromSyntax)];
        expect(kinds.every(kind => prelude.includes(kind))).toBe(true);
        expect(prelude.every(kind => kinds.includes(kind))).toBe(true);
        expect(prelude).toHaveLength(4);
    });

    it('every function reachable from the global object of a realm is of a kind the prelude names', () => {
        const { run } = stringlessRealm();
        const prelude = run<object[]>(`${FUNCTION_KINDS_SOURCE}.map(Object.getPrototypeOf)`);
        const found = run<object[]>(`(() => {
            const seen = new Set(), kinds = new Set(), queue = [globalThis];
            while (queue.length) {
                const value = queue.pop();
                if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue;
                seen.add(value);
                // a function's kind: the nearest prototype on its chain that is a kind's (its constructor's prototype is
                // itself), past the constructors a class extends (RangeError's is Error, Int8Array's is TypedArray);
                // Function.prototype, a function itself, is a kind's prototype and of no kind
                const isKind = (object) => Object.hasOwn(object, 'constructor') && object.constructor.prototype === object;
                if (typeof value === 'function' && !isKind(value)) {
                    let kind = Object.getPrototypeOf(value);
                    while (typeof kind === 'function' && !isKind(kind)) kind = Object.getPrototypeOf(kind);
                    kinds.add(kind);
                }
                queue.push(Object.getPrototypeOf(value));
                for (const key of Reflect.ownKeys(value)) {
                    const d = Object.getOwnPropertyDescriptor(value, key);
                    if (d) queue.push(d.value, d.get, d.set);
                }
            }
            return [...kinds];
        })()`);
        expect(found.length).toBeGreaterThan(0);
        expect(found.filter(kind => !prelude.includes(kind))).toEqual([]);
    });

    it("the table's function kinds and globals are every sink the realm's own names reach", () => {
        expect(Object.keys(CODE_FROM_STRING_SINKS)).toEqual([...REFUSED_GLOBALS, ...Object.keys(CODE_FROM_STRING_SINKS).filter(id => id.endsWith('.constructor')), ...REFUSED_TIMERS]);
        expect(REFUSED_GLOBALS).toEqual(['eval', 'Function']);
        expect(REFUSED_TIMERS).toEqual(['setTimeout', 'setInterval']);
    });
});

describe('refuseCodeFromStrings: every sink throws the library\'s EvalError and never reaches the platform', () => {
    // each a guest's attempt, as an expression
    const ATTEMPTS: Record<string, string> = {
        'eval': "eval('1')",
        'indirect eval': "(0, eval)('1')",
        'globalThis.eval': "globalThis.eval('1')",
        'Function()': "Function('return 1')",
        'new Function()': "new Function('return 1')",
        'Reflect.construct(Function)': "Reflect.construct(Function, ['return 1'])",
        'setTimeout(string)': "setTimeout('1')",
        'setInterval(string)': "setInterval('1', 1000)",
        'setTimeout(undefined)': 'setTimeout(undefined)',
    };
    for (const syntax of FUNCTION_SYNTAXES) ATTEMPTS[`(${syntax}).constructor`] = `(${syntax}).constructor('return 1')`;
    for (const syntax of FUNCTION_SYNTAXES) ATTEMPTS[`new ((${syntax}).constructor)`] = `new ((${syntax}).constructor)('return 1')`;

    it('positive control: without the prelude, the platform throws its own error for each', () => {
        const { run } = stringlessRealm();
        const outcomes = run<Record<string, string>>(`(() => { const out = {}; for (const [k, c] of Object.entries(${JSON.stringify(ATTEMPTS)})) { try { (0, eval)(c); out[k] = 'ran'; } catch (e) { out[k] = e.name + ': ' + e.message; } } return out; })()`);
        // eval itself is the platform's: the realm refuses even the harness's indirect eval
        expect(Object.values(outcomes).every(outcome => !outcome.includes(CODE_FROM_STRING_REFUSAL))).toBe(true);
    });

    it('with the prelude, each attempt throws EvalError with the library\'s text', () => {
        const { run } = stringlessRealm();
        run(prelude());
        const attempts = Object.entries(ATTEMPTS).map(([name, code]) => `[${JSON.stringify(name)}, () => ${code}]`).join(', ');
        const outcomes = run<Record<string, string>>(`(() => { const out = {}; for (const [k, f] of [${attempts}]) { try { f(); out[k] = 'ran'; } catch (e) { out[k] = e.name + ': ' + e.message; } } return out; })()`);
        const expected = Object.fromEntries(Object.keys(ATTEMPTS).map(name => [name, `EvalError: ${CODE_FROM_STRING_REFUSAL}`]));
        expect(outcomes).toEqual(expected);
    });

    it('nothing the guest holds reaches the platform: no copy on the prototype chain, delete does not uncover one, instanceof answers as before', () => {
        const { run, calls } = stringlessRealm();
        const platform = run<Record<string, unknown>>('({ eval: globalThis.eval, Function: globalThis.Function, setTimeout: globalThis.setTimeout })');
        run(prelude());
        const reachable = run<unknown[]>(`(() => {
            const out = [];
            for (let o = globalThis; o; o = Object.getPrototypeOf(o)) for (const k of ['eval', 'Function', 'setTimeout', 'setInterval']) { const d = Object.getOwnPropertyDescriptor(o, k); if (d) out.push(d.value); }
            for (const f of ${FUNCTION_KINDS_SOURCE}) out.push(Object.getPrototypeOf(f).constructor);
            return out;
        })()`);
        expect(reachable).not.toContain(platform.eval);
        expect(reachable).not.toContain(platform.Function);
        expect(reachable).not.toContain(platform.setTimeout);
        expect(run('delete globalThis.eval; delete globalThis.setTimeout; [typeof eval, typeof setTimeout]')).toEqual(['undefined', 'undefined']);
        expect(run('[(function () {}) instanceof Function, (async () => {}) instanceof Function, Function === (function () {}).constructor, Function.prototype === Object.getPrototypeOf(function () {})]')).toEqual([true, true, true, true]);
        expect(calls()).toEqual([]);
    });

    it('a timer given a function runs on the platform\'s timer with every argument as given', () => {
        const { run, calls } = stringlessRealm();
        run(prelude());
        expect(run('const f = () => {}; globalThis.f = f; [setTimeout(f, 5, "a", 2), setInterval(f, 7)]')).toEqual([1, 2]);
        const f = run('f');
        expect(calls()).toEqual([['setTimeout', f, 5, 'a', 2], ['setInterval', f, 7]]);
    });
});

describe('the other compilers are absent from the worker', () => {
    it('each one of ABSENT_COMPILERS is off the strict allowlist, or removed by the prelude', () => {
        const prelude = inStrictWorker.toString();
        for (const name of Object.keys(ABSENT_COMPILERS)) {
            if (!STRICT_WORKER_GLOBALS.includes(name)) continue;
            expect(name).toBe('WebAssembly');
            expect(prelude).toMatch(/if \(!options\.scriptUnsafe\) remove\(g, ["']WebAssembly["']\)/);
        }
    });
});

describe('the view runs no guest code, so no string of the guest\'s runs as code there', () => {
    // In strict and sealed mode the guest has no script in the view: the view's script-src admits the bootstrap's hash
    // alone (no 'unsafe-inline', no 'unsafe-eval', script-src-attr 'none'), and the renderer drops every script and handler
    // before insertion (test/e2e/strict.spec.ts, G1, on every engine). So the sinks the worker refuses have no second home
    // in the view, and the view's own checks of the host page's policy are of the library's loads and the guest's markup.
    it("sealed mode's view policy admits the bootstrap's hash and nothing else as script", () => {
        const hash = viewBootstrapHash();
        const policy = sealedViewPolicy({ fileKinds: new Set(SEALED_FILE_KINDS), bootstrapHash: hash });
        const directives = new Map(policy.split('; ').map(part => { const [name, ...sources] = part.split(' '); return [name!, sources]; }));
        expect(directives.get('script-src')).toEqual([hash]);
        expect(directives.get('script-src-attr')).toEqual(["'none'"]);
        expect(policy).not.toContain('unsafe-eval');
    });
});
