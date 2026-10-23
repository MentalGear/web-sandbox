import { builtinEnvironments, type Environment } from 'vitest/environments';

/**
 * vitest's jsdom environment, with one change to its teardown. A unit test that runs a bootstrap runs it on jsdom's
 * global, and the bootstrap's request gate pins `fetch`, `XMLHttpRequest` and `WebSocket` there as not configurable,
 * as it does in a sandbox document (src/lib/in-sandbox-script.ts). jsdom's teardown deletes every global it added,
 * which throws for a pinned one; here a delete of a property that cannot be deleted is left out, and every other step
 * of the teardown runs as before.
 */
export default <Environment>{
    name: 'jsdom-sandbox',
    viteEnvironment: 'client',
    async setup(global, options) {
        const { teardown } = await builtinEnvironments.jsdom.setup(global, options);
        const pinned = (key: PropertyKey) => Object.getOwnPropertyDescriptor(global, key)?.configurable === false;
        const view = new Proxy({}, {
            get: (_, key) => Reflect.get(global, key),
            set: (_, key, value) => Reflect.set(global, key, value),
            deleteProperty: (_, key) => pinned(key) || Reflect.deleteProperty(global, key),
        });
        return { teardown: () => teardown(view) };
    },
};
