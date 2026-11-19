import { APP_FILES_KEY, GRANT_METHODS_KEY } from '@src/lib/app-start';
import { APP_OPTIONS } from '@src/lib/config-schema';

/**
 * One app per element, for the unit tests (design 01, "start(app, grants)"): a test states its sandbox as one flat
 * configuration, as docs/API.md's options table lists them, with the app's files and the host methods beside it, and
 * these helpers hand it to the element's one `start(app, grants)`. A second configuration is a second element.
 *
 * The split is the schema's own: an option the schema gives to the app (`owner: 'app'`) goes in the app, every other one
 * in the grants, so a configuration never puts an option in the argument that refuses it. Not a test file itself.
 */

/** A configuration as a test writes it: the options of both arguments, in one object. */
export type Configuration = Readonly<Record<string, unknown>>;

/** What a test hands start() besides the options: the app's files and the host methods. */
export interface AppSetup {
    /** The app's files, by path, as `start()` takes them in `app.files`. */
    readonly files?: Readonly<Record<string, unknown>>;
    /** The host methods, by name, as `start()` takes them in `grants.methods`. */
    readonly methods?: Readonly<Record<string, (...args: any[]) => unknown>>;
}

/** start()'s two arguments for `config` and `setup`: the app's options and files, and the embedder's options and methods. */
export function startArguments(config: Configuration, setup: AppSetup = {}): [app: Record<string, unknown>, grants: Record<string, unknown>] {
    const app: Record<string, unknown> = {};
    const grants: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(config)) {
        const argument = (APP_OPTIONS as readonly string[]).includes(name) ? app : grants;
        argument[name] = value;
    }
    if (setup.files !== undefined) app[APP_FILES_KEY] = setup.files;
    if (setup.methods !== undefined) grants[GRANT_METHODS_KEY] = setup.methods;
    return [app, grants];
}

/** Starts `el` with `config` and `setup` (startArguments), and returns it. Throws what start() throws. */
export function startWith<T extends { start(app: unknown, grants?: unknown): void }>(el: T, config: Configuration, setup: AppSetup = {}): T {
    const [app, grants] = startArguments(config, setup);
    el.start(app, grants);
    return el;
}

/** Where a test's new element goes before start(): into the document (it builds at once), or nowhere (it builds on insertion). */
export interface MountOptions {
    /** Whether the element is in the document when it is started. Default `true`. */
    readonly connect?: boolean;
    /** Runs on the new element before it is inserted and started: a listener, a spy. */
    readonly before?: (el: any) => void;
}

/**
 * A new `<web-sandbox>` of this file's build (the element is defined on first use), inserted (unless `connect` is
 * false), then started with `config` and `setup`.
 */
export async function mountApp(config: Configuration, setup: AppSetup = {}, { connect = true, before }: MountOptions = {}): Promise<any> {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    before?.(el);
    if (connect) document.body.appendChild(el);
    return startWith(el, config, setup);
}
