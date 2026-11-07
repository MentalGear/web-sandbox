/**
 * Code from strings in the guest's worker (S74, class A: INHERITED_CONTEXT.cspPolicyText and cspReporting; BD6:ISO-1,
 * BD6:ISO-2). The worker inherits the host page's whole policy list through the view, the policy's text and its reporting
 * endpoints with it, and the browser checks every policy of that list when code asks it to run a string: a policy that
 * refuses dispatches a `securitypolicyviolation` event in the worker carrying its text (`originalPolicy`: the page's nonce,
 * its report endpoint and the key in it), puts its directive in the engine's error message (Chromium), and makes the
 * browser POST a report, with a sample of the string, to the page's endpoint. So in strict and sealed mode the guest never
 * reaches that check: before its entry runs, the prelude puts the library's own refusal in place of every sink below, an
 * `EvalError` with the library's text that never calls the platform. Nothing is checked, so nothing is dispatched,
 * reported or quoted. The platform's sinks are not kept anywhere guest code can reach; the bootstrap's own `execute()`
 * captured the platform's `Function` before (in-sandbox-script.ts), and runs only with `scriptUnsafe`, in strict mode,
 * where the prelude leaves the sinks as the platform has them (sealed mode refuses `scriptUnsafe`, config-schema.ts).
 *
 * The other ways a worker compiles text are off the allowlist the build passes (worker-globals.ts), so the guest
 * has none of them: {@link ABSENT_COMPILERS}. A dynamic `import()` is syntax, which nothing at run time can take from the
 * language: the build refuses an entry that calls it (entry-imports.ts).
 *
 * Values first: test/unit/code-from-strings.test.ts enumerates the function kinds from the language (each kind's syntax,
 * and every function reachable from a realm's global object) against {@link CODE_FROM_STRING_SINKS}, so a new kind is
 * classified before it ships, and runs {@link refuseCodeFromStrings} in a realm where the platform's code generation is
 * off, so a sink that reached the platform would throw the platform's error, not the library's.
 */

/** The library's refusal, the message of every `EvalError` a refused sink throws. */
export const CODE_FROM_STRING_REFUSAL = '[Sandbox] a string does not run as code in the sandbox (eval, Function, a timer given a string): pass a function';

/** How a sink is found in the worker's realm. */
export type SinkKind =
    /** a property of the global object (or of its prototype chain) */
    | 'global'
    /** the `constructor` of a function kind's prototype, the kind made by `syntax` */
    | 'function-kind'
    /** a timer of the global object, which compiles its handler when the handler is not a function */
    | 'timer';

export interface CodeFromStringSink {
    readonly kind: SinkKind;
    /** function-kind: an expression of the language that makes a function of that kind. */
    readonly syntax?: string;
    /** What of a call the library refuses. */
    readonly refuses: string;
}

/** Every way the worker's realm compiles a string, and what of it the prelude refuses. */
export const CODE_FROM_STRING_SINKS = {
    'eval': { kind: 'global', refuses: 'every call, direct or indirect' },
    'Function': { kind: 'global', refuses: 'every call and construction (the same function as `Function.prototype.constructor`)' },
    'Function.prototype.constructor': { kind: 'function-kind', syntax: 'function () {}', refuses: 'every call and construction' },
    'AsyncFunction.prototype.constructor': { kind: 'function-kind', syntax: 'async function () {}', refuses: 'every call and construction' },
    'GeneratorFunction.prototype.constructor': { kind: 'function-kind', syntax: 'function* () {}', refuses: 'every call and construction' },
    'AsyncGeneratorFunction.prototype.constructor': { kind: 'function-kind', syntax: 'async function* () {}', refuses: 'every call and construction' },
    'setTimeout': { kind: 'timer', refuses: 'a handler that is not a function' },
    'setInterval': { kind: 'timer', refuses: 'a handler that is not a function' },
} as const satisfies Record<string, CodeFromStringSink>;

export type CodeFromStringSinkId = keyof typeof CODE_FROM_STRING_SINKS;

const SINK_IDS = Object.keys(CODE_FROM_STRING_SINKS) as CodeFromStringSinkId[];
const sinkOf = (id: CodeFromStringSinkId): CodeFromStringSink => CODE_FROM_STRING_SINKS[id];

/** The names of the global object the prelude replaces, in the table's order. */
export const REFUSED_GLOBALS: readonly string[] = SINK_IDS.filter(id => sinkOf(id).kind === 'global');

/** The timers the prelude wraps, in the table's order. */
export const REFUSED_TIMERS: readonly string[] = SINK_IDS.filter(id => sinkOf(id).kind === 'timer');

/**
 * The source text of an array literal with one function of each kind, in the table's order, written into the worker's
 * source as text (host.ts): no bundler of the embedder's can rewrite the syntax of a kind (an async function made into
 * a generator helper would be another kind, and would reach outside the stringified function), and the prelude takes each
 * kind's prototype from it.
 */
export const FUNCTION_KINDS_SOURCE = `[${SINK_IDS.filter(id => sinkOf(id).kind === 'function-kind').map(id => sinkOf(id).syntax).join(', ')}]`;

/**
 * The worker's other ways to compile or load code, which the guest never has: each is off the allowlist the build passes
 * without `scriptUnsafe` (STRICT_WORKER_GLOBALS and workerGlobalsFor, worker-globals.ts), so the worker deletes it before
 * guest code runs. With why each would check the inherited policy.
 */
export const ABSENT_COMPILERS = {
    'importScripts': 'loads a classic script: script-src',
    'Worker': 'a nested worker of a URL: worker-src',
    'SharedWorker': 'a shared worker of a URL: worker-src',
    'WebAssembly': "compiles bytes: 'wasm-unsafe-eval' (off the allowlist unless scriptUnsafe, workerGlobalsFor)",
    'ShadowRealm': 'evaluate() compiles a string: script-src',
    'trustedTypes': 'the Trusted Types factory, whose policies make the values a sink accepts',
    'TrustedScript': 'a value a Trusted Types sink accepts as code',
} as const;

/**
 * The prelude's last statement before the guest's entry, in strict and sealed mode without `scriptUnsafe`: every sink of
 * CODE_FROM_STRING_SINKS becomes the library's refusal. Stringified into the worker's source (host.ts); self-contained.
 * `kinds` holds one function of each kind (FUNCTION_KINDS_SOURCE, evaluated there), `globals` and `timers` the names, and
 * `text` the refusal's message.
 *
 * Each `constructor` of a kind's prototype becomes a function that throws, whose `prototype` is that kind's prototype (so
 * `instanceof` still answers as before), with its property's attributes as they were; `Function` on the global object is
 * the same function as `Function.prototype.constructor`. `eval` becomes a function that throws. A timer becomes one that
 * throws for a handler that is not a function and hands every other call to the platform's timer, with its arguments as
 * given. Every copy of a replaced name on the global object's prototype chain is removed, so the platform's is reachable
 * from no object the guest holds; a copy that stays after its removal fails the worker (the entry never starts), as the
 * globals allowlist does.
 */
export function refuseCodeFromStrings(g: object, kinds: readonly object[], globals: readonly string[], timers: readonly string[], text: string) {
    const apply = Reflect.apply;
    const construct = Reflect.construct;
    const defineOwn = Reflect.defineProperty;
    const deleteOwn = Reflect.deleteProperty;
    const getOwn = Object.getOwnPropertyDescriptor;
    const protoOf = Object.getPrototypeOf;
    const EvalErrorConstructor = EvalError;
    const ErrorConstructor = Error;
    const CAPTURE_POINT = 'nothing below reads a global, or an intrinsic guest code can replace';

    const failed = (what: string) => construct(ErrorConstructor, ['[Sandbox] the strict worker could not replace ' + what]);
    // A function that throws the library's refusal and never reaches the platform: called, or constructed.
    const refusal = (name: string) => {
        const refuse = function () {
            throw construct(EvalErrorConstructor, [text]);
        };
        defineOwn(refuse, 'name', { value: name, configurable: true });
        return refuse;
    };
    // `value` in place of every copy of `name` on the global object and its prototype chain, as an own property of the
    // global object with the attributes the nearest copy had.
    const replace = (name: string, value: unknown) => {
        let found: PropertyDescriptor | undefined;
        for (let owner: object | null = g; owner; owner = protoOf(owner)) {
            const own = getOwn(owner, name);
            if (!own) continue;
            if (!found) found = own;
            deleteOwn(owner, name);
            if (getOwn(owner, name)) throw failed(name);
        }
        const enumerable = found ? found.enumerable === true : false;
        if (!defineOwn(g, name, { value, writable: true, enumerable, configurable: true })) throw failed(name);
    };
    // The platform's value of `name`: the nearest copy on the global object's prototype chain.
    const platformOf = (name: string): unknown => {
        for (let owner: object | null = g; owner; owner = protoOf(owner)) {
            const own = getOwn(owner, name);
            if (own) return own.value;
        }
        return undefined;
    };

    // the function kinds: each prototype's constructor; the first kind is Function's, which the global object names too
    let functionRefusal: unknown = null;
    for (let i = 0; i < kinds.length; i++) {
        const prototype = protoOf(kinds[i]!) as object;
        const own = getOwn(prototype, 'constructor');
        const original = own ? own.value as { name?: unknown } | null : null;
        const named = original ? original.name : undefined;
        const fake = refusal(typeof named === 'string' ? named : 'Function');
        defineOwn(fake, 'prototype', { value: prototype, writable: false, enumerable: false, configurable: false });
        const attributes = { value: fake, writable: own ? own.writable === true : true, enumerable: own ? own.enumerable === true : false, configurable: own ? own.configurable === true : true };
        if (!defineOwn(prototype, 'constructor', attributes)) throw failed('a function constructor');
        if (i === 0) functionRefusal = fake;
    }
    for (let i = 0; i < globals.length; i++) {
        const name = globals[i]!;
        replace(name, name === 'Function' && functionRefusal ? functionRefusal : refusal(name));
    }
    for (let i = 0; i < timers.length; i++) {
        const name = timers[i]!;
        const platform = platformOf(name);
        if (typeof platform !== 'function') continue;
        const timer = function (handler: unknown) {
            if (typeof handler !== 'function') throw construct(EvalErrorConstructor, [text]);
            return apply(platform, g, arguments); // as given: the platform reads its own arguments, delay and extra ones included
        };
        defineOwn(timer, 'name', { value: name, configurable: true });
        replace(name, timer);
    }
}
