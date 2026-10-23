import { builtinEnvironments, type Environment } from 'vitest/environments';

/**
 * vitest's jsdom environment, with two changes to its teardown. A unit test that runs a bootstrap runs it on jsdom's
 * global, and the bootstrap stays as it would in a sandbox document:
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
        const { teardown } = await builtinEnvironments.jsdom.setup(global, options);
        const clearTimers = trackTimers(global);
        const pinned = (key: PropertyKey) => Object.getOwnPropertyDescriptor(global, key)?.configurable === false;
        const view = new Proxy({}, {
            get: (_, key) => Reflect.get(global, key),
            set: (_, key, value) => Reflect.set(global, key, value),
            deleteProperty: (_, key) => pinned(key) || Reflect.deleteProperty(global, key),
        });
        return {
            teardown: () => {
                clearTimers();
                return teardown(view);
            },
        };
    },
};

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
