import { builtinEnvironments, type Environment } from 'vitest/environments';

/**
 * vitest's jsdom environment, with no network, and with two changes to its teardown.
 *
 * No network: jsdom has no `fetch`, and the one vitest leaves on the global is Node's, which reaches the machine's own
 * network (the element's check of sealed mode's served file requests `documentUrl`, src/lib/document-check.ts, and the
 * jsdom page's origin is `http://localhost:3000`, whatever answers there). So the global has none, as a document
 * without the API: the element's check cannot be made, and a sealed build frames at once, as before any check existed
 * in a realm without `fetch`. A file whose subject is a realm that has one (the fetch bridge's frame, whose `fetch` its
 * tests replace) declares it, `// @vitest-environment-options {"unitFetch":"refuse"}`: its global then has a `fetch`
 * that refuses every request, as a network failure does. Node's is put back at the teardown.
 *
 * A unit test that runs a bootstrap runs it on jsdom's global, and the bootstrap stays as it would in a sandbox document:
 *
 * - its request gate pins `fetch`, `XMLHttpRequest` and `WebSocket` there as not configurable (src/lib/in-sandbox-script.ts).
 *   jsdom's teardown deletes every global it added, which throws for a pinned one; here a delete of a property that
 *   cannot be deleted is left out.
 * - its timers keep running (the view's render meter and scheduler, src/lib/in-sandbox-view.ts). The timer functions
 *   are Node's, which closing jsdom's window does not stop, so one could fire after `document` is gone and fail the run
 *   with "document is not defined". Every timer started through the global is cleared before the teardown, so none
 *   outlives its test file.
 *
 * Every other step of the teardown runs as before.
 */
export default <Environment>{
    name: 'jsdom-sandbox',
    viteEnvironment: 'client',
    async setup(global, options) {
        const nodeFetch = Object.getOwnPropertyDescriptor(global, 'fetch');
        const { teardown } = await builtinEnvironments.jsdom.setup(global, options);
        if (asksForFetch(options)) Object.defineProperty(global, 'fetch', { value: unitFetch, writable: true, configurable: true });
        else Reflect.deleteProperty(global, 'fetch');
        const clearTimers = trackTimers(global);
        const pinned = (key: PropertyKey) => Object.getOwnPropertyDescriptor(global, key)?.configurable === false;
        const view = new Proxy({}, {
            get: (_, key) => Reflect.get(global, key),
            set: (_, key, value) => Reflect.set(global, key, value),
            deleteProperty: (_, key) => pinned(key) || Reflect.deleteProperty(global, key),
        });
        return {
            teardown: async () => {
                clearTimers();
                await teardown(view);
                const left = Object.getOwnPropertyDescriptor(global, 'fetch');
                if (nodeFetch && (left === undefined || left.value === unitFetch)) Object.defineProperty(global, 'fetch', nodeFetch);
            },
        };
    },
};

// Whether a file's environment options ask for a fetch: vitest files a file's `@vitest-environment-options` under the
// name of its environment, which for this one is its path.
function asksForFetch(options: Record<string, unknown>): boolean {
    for (const value of Object.values(options)) {
        if (typeof value === 'object' && value !== null && (value as { unitFetch?: unknown }).unitFetch === 'refuse') return true;
    }
    return false;
}

// The unit environment's fetch: no request reaches a network; each is refused as a network failure is.
async function unitFetch(): Promise<never> {
    throw new TypeError('the unit environment makes no request');
}

// Replaces the global's setTimeout and setInterval with ones that record what is pending; returns a function that
// clears it all. The replacements keep the originals' own properties (util.promisify's custom one among them).
function trackTimers(global: any): () => void {
    const pending = new Set<unknown>();
    const { setTimeout: setOnce, setInterval: setEvery, clearTimeout: clear, clearInterval: clearEvery } = global;
    const once = function (this: unknown, callback: unknown, ...rest: unknown[]) {
        if (typeof callback !== 'function') return setOnce.call(this, callback, ...rest);
        const handle = setOnce.call(this, function (this: unknown, ...args: unknown[]) {
            pending.delete(handle);
            return callback.apply(this, args);
        }, ...rest);
        pending.add(handle);
        return handle;
    };
    const every = function (this: unknown, ...args: unknown[]) {
        const handle = setEvery.apply(this, args);
        pending.add(handle);
        return handle;
    };
    const forget = (original: (handle: unknown) => void) => function (this: unknown, handle: unknown) {
        pending.delete(handle);
        return original.call(this, handle);
    };
    Object.defineProperties(once, Object.getOwnPropertyDescriptors(setOnce));
    Object.defineProperties(every, Object.getOwnPropertyDescriptors(setEvery));
    global.setTimeout = once;
    global.setInterval = every;
    global.clearTimeout = forget(clear);
    global.clearInterval = forget(clearEvery);
    return () => {
        for (const handle of pending) clear(handle);
        pending.clear();
        Object.assign(global, { setTimeout: setOnce, setInterval: setEvery, clearTimeout: clear, clearInterval: clearEvery });
    };
}
