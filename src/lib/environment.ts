/**
 * The resources of one environment, declared once (class L; LM-2; S74). Internal: src/index.ts does not export it.
 *
 * An environment is what a build makes and a teardown ends: its frame, ports, listener, timers, watchdogs, resizer and
 * fetch bridge. `ENVIRONMENT_RELEASES` lists them, in the order they are released, each with its release. The element's
 * `_teardown` is two steps over that list:
 * 1. `detachEnvironment` takes every listed field's value into a record and clears the field, in one step that runs no
 *    platform code;
 * 2. `releaseEnvironment` releases from the record, and only from it.
 *
 * A release can run embedder code before it returns: a frame's removal fires the host window's `focus` on Firefox, and a
 * focused guest's `pagehide` handler calls `parent.parent.focus()` on every engine. A listener that calls reset(),
 * load() or setConfig() builds a whole new environment from inside the old teardown. Because the fields already say "no
 * environment", that build fills fields the outer teardown never touches again, and the outer teardown releases the old
 * environment's resources only. A field written by a release instead (`this._iframe = null` after `remove()`) would
 * overwrite the nested build's, orphan its frame and close its bridge.
 *
 * `ENVIRONMENT_RELEASES` is a `Record` over every field of `EnvironmentFields`: a field added there without a release
 * does not compile, and a release without a field does not either. test/unit/teardown-reentry.test.ts re-enters at every
 * entry of the list.
 */
import type { AutoResizer } from './auto-resize';
import type { BridgeFrame } from './bridge-frame';
import type { FetchBridge } from './fetch-bridge';
import type { LongTimeout } from './long-timer';
import type { Watchdog } from './watchdog';

/** Why a guest write the view never confirmed was answered as lost. */
const UNSHOWN_WRITE_MESSAGE = '[Sandbox] the sandbox was reset or terminated before the view showed this write.';

/** The element's per-environment fields, with their types: the element declares its own fields from these. */
export interface EnvironmentFields {
    /** The reversed handshake's listener on the host's window (cooperative and worker mode). */
    _stopListening: (() => void) | null;
    /** The build's load deadline, until the guest checks in. */
    _loadDeadline: Watchdog | null;
    /** The wrapper frame. */
    _iframe: HTMLIFrameElement | null;
    /** The guest's port: the guest document's bootstrap, or the worker. */
    _port: MessagePort | null;
    /** Strict mode: the view's port. */
    _viewPort: MessagePort | null;
    /** Strict mode: the view liveness check. */
    _viewWatchdog: Watchdog | null;
    /** The guest liveness check. */
    _watchdog: Watchdog | null;
    /** The auto-sizing, when on. */
    _resizer: AutoResizer | null;
    /** The fetch bridge, when on. */
    _fetchBridge: FetchBridge | null;
    /** The frame that makes the bridge's requests. */
    _bridgeFrame: BridgeFrame | null;
    /** Strict mode: guest writes posted to the view and not yet confirmed, by id. */
    _viewWrites: Map<number, { shown: () => void; lost: (error: Error) => void }>;
    /** The workerExecutionTimeout deadlines. */
    _executionTimers: Set<LongTimeout>;
    /** The liveness probes started at a deadline: each ping number → its end. */
    _executionProbes: Map<number, () => void>;
}

export type EnvironmentField = keyof EnvironmentFields;

/** What a detached field holds to release: its value, or for a collection each of its distinct members. */
export type Held<T> = T extends Map<unknown, infer V> ? V[] : T extends Set<infer V> ? V[] : NonNullable<T>;

type Releases = { [K in EnvironmentField]: (held: Held<EnvironmentFields[K]>) => void };

// A node removed by the platform from inside its own removal (a pagehide handler whose embedder code removed it first)
// is gone, which is what the release wants.
function removeFrame(frame: HTMLIFrameElement): void {
    frame.onload = null;
    try {
        frame.remove();
    } catch (error) {
        if ((error as { name?: unknown } | null)?.name !== 'NotFoundError') throw error;
    }
}

/**
 * Every per-environment field, in the order its resource is released. The frames go last: removing a frame is where the
 * platform runs embedder code, and by then everything else of the environment has ended.
 */
export const ENVIRONMENT_RELEASES: Releases = {
    _stopListening: (stop) => stop(),
    _loadDeadline: (deadline) => deadline.stop(),
    _port: (port) => port.close(),
    _viewPort: (port) => port.close(),
    _viewWrites: (write) => { for (const { lost } of write) lost(new Error(UNSHOWN_WRITE_MESSAGE)); },
    _executionTimers: (timers) => { for (const timer of timers) timer.cancel(); },
    _executionProbes: (ends) => { for (const end of ends) end(); },
    _watchdog: (watchdog) => watchdog.stop(),
    _viewWatchdog: (watchdog) => watchdog.stop(),
    _resizer: (resizer) => resizer.stop(), // the height it wrote stays until the next report
    _fetchBridge: (bridge) => bridge.abortAll(), // upstream requests end with the environment
    _iframe: removeFrame,
    _bridgeFrame: (frame) => frame.close(), // and so does the frame that made them
};

/** The declared fields, in release order. */
export const ENVIRONMENT_FIELDS = Object.keys(ENVIRONMENT_RELEASES) as readonly EnvironmentField[];

/** What `detachEnvironment` took: the values to release, each with its field. */
export type DetachedEnvironment = [field: EnvironmentField, held: unknown][];

/**
 * Takes every declared field's value into the record and clears the field (a collection is copied, then emptied). Runs
 * no platform code, so the element describes "no environment" before the first release.
 */
export function detachEnvironment(element: object): DetachedEnvironment {
    const fields = element as { [K in EnvironmentField]: EnvironmentFields[K] };
    const detached: DetachedEnvironment = [];
    for (const field of ENVIRONMENT_FIELDS) {
        const value = fields[field];
        if (value instanceof Map) {
            detached.push([field, [...new Set((value as Map<unknown, unknown>).values())]]);
            value.clear();
        } else if (value instanceof Set) {
            detached.push([field, [...(value as Set<unknown>)]]);
            value.clear();
        } else if (value !== null) {
            detached.push([field, value]);
            (fields as Record<string, unknown>)[field] = null;
        }
    }
    return detached;
}

/**
 * Releases the record, in order. A release that throws does not stop the ones after it: the first failure is rethrown
 * once all have run, so an environment is never left half released.
 */
export function releaseEnvironment(detached: DetachedEnvironment): void {
    let failed = false;
    let failure: unknown;
    for (const [field, held] of detached) {
        try {
            (ENVIRONMENT_RELEASES[field] as (held: unknown) => void)(held);
        } catch (error) {
            if (!failed) { failed = true; failure = error; }
        }
    }
    if (failed) throw failure;
}
