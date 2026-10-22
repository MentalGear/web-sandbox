import { ENVIRONMENT_EXPECTED, type EnvironmentCheckId } from '@src/lib/environment-check';

/**
 * The environment a library bootstrap finds in a sandbox document (src/lib/environment-check.ts), for a unit test that
 * runs a bootstrap's text in jsdom: the origin, URL and base URL the library built its documents with. jsdom loads no
 * srcdoc document, so a test that runs a bootstrap runs it here; a test of one row gives that row another value.
 *
 * jsdom's window is its own parent, and a bootstrap posts nothing to the window it runs in, so a test that listens for
 * the refusal asks for `captureRefusals`: the host page's window (`parent.parent`, and `parent` for the bridge's frame)
 * is then a recorder, for the run only. Otherwise `parent` stays as it is, which the view's tests rely on (the window
 * that hands the view its ports is the one the view finds as `parent.parent`).
 */
export interface SandboxEnvironmentRecord {
    /**
     * What the bootstrap posted to the host page's window (only with `captureRefusals`): the frame, the target origin, the
     * number of objects transferred, and which window it reached it through (`parent`, the bridge's frame's host page, or
     * `parent.parent`, every other frame's).
     */
    readonly posted: { readonly data: unknown; readonly targetOrigin: unknown; readonly transferred: number; readonly via: 'parent' | 'parent.parent' }[];
    /** How many times the bootstrap stopped the document's parser (`window.stop()`). */
    stops: number;
}

export type EnvironmentOverrides = Partial<Record<EnvironmentCheckId, string>>;

export interface SandboxDocumentOptions {
    /** Rows that read another value than the one a built document reads. */
    readonly overrides?: EnvironmentOverrides;
    /** The host page's window is a recorder of the refusals posted to it (`SandboxEnvironmentRecord.posted`). */
    readonly captureRefusals?: boolean;
    /** The script element the bootstrap finds as `document.currentScript` (the bridge's frame's has the bridge's role). */
    readonly currentScript?: Element;
}

type Slot = readonly [target: object, key: string, saved: PropertyDescriptor | undefined];

/** Runs `run` with the globals a bootstrap reads standing as in a sandbox document, `overrides` replacing rows; restores them after. */
export function inSandboxDocument<T>(run: (record: SandboxEnvironmentRecord) => T, options: SandboxDocumentOptions = {}): T {
    const expected = { ...ENVIRONMENT_EXPECTED, ...options.overrides };
    const record: SandboxEnvironmentRecord = { posted: [], stops: 0 };
    const hostVia = (via: 'parent' | 'parent.parent') => ({
        postMessage: (data: unknown, targetOrigin: unknown, transfer?: unknown[]) => void record.posted.push({ data, targetOrigin, transferred: transfer?.length ?? 0, via }),
    });
    const slots: Slot[] = [];
    const define = (target: object, key: string, descriptor: PropertyDescriptor) => {
        slots.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
        Object.defineProperty(target, key, { configurable: true, ...descriptor });
    };
    define(globalThis, 'origin', { value: expected.origin });
    define(globalThis, 'location', { value: { href: expected.url } });
    define(document, 'baseURI', { get: () => expected.base });
    if (options.captureRefusals) define(globalThis, 'parent', { value: { ...hostVia('parent'), parent: hostVia('parent.parent') } });
    if (options.currentScript) define(document, 'currentScript', { get: () => options.currentScript });
    define(window, 'stop', { value: () => void record.stops++ });
    try {
        return run(record);
    } finally {
        for (const [target, key, saved] of slots.reverse()) {
            if (saved) Object.defineProperty(target, key, saved);
            else delete (target as Record<string, unknown>)[key];
        }
    }
}

/** Runs a bootstrap's text as the document's script would, in the environment of a sandbox document (`inSandboxDocument`). */
export function runBootstrap(text: string, options: SandboxDocumentOptions = {}): SandboxEnvironmentRecord {
    return inSandboxDocument(record => {
        new Function(text)();
        return record;
    }, options);
}
