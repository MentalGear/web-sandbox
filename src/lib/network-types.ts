/**
 * The types of the network modes (research 24, D9; ADR-009): the configurations of strict, cooperative and worker mode
 * and the options that open the network, and the `fetch` event. Only the network build's entry (src/network.ts) exports
 * them, and they join the element's own types by declaration merging (below), so the default build's declarations
 * describe sealed mode alone: a config the build refuses does not type-check there.
 */
import type { UnsafeCapability } from '../csp-directives';
import type { SandboxConfigOptions } from '../host';
import type { SandboxOrigins, StrictSandboxOrigins } from './csp/origins';
import type { FetchBridgeConfig, FetchRecord } from './fetch-bridge';

/**
 * The options that open the network: `origins` and `fetchBridge`. Strict, cooperative and worker mode take them; sealed
 * mode does not.
 */
export interface NetworkSandboxOptions {
    /**
     * The exact origins the guest may load each kind from (ADR-007). Strict mode's have no `scripts`
     * ({@link StrictSandboxConfig}).
     *
     * @defaultValue none
     */
    origins?: SandboxOrigins;
    /**
     * Opens `sandboxFetch()` in the guest: the host decides each request under a fixed discipline (exact-origin
     * allowlist, no credentials, no redirects, capped body and time), a hidden frame of the library's with an opaque
     * origin makes it (the target sees `Origin: null`), and the host reports it as a `fetch` event. The guest's
     * policy is unchanged. Without it, `sandboxFetch()` rejects with `FETCH_NOT_ALLOWED`. See ADR-006.
     *
     * @defaultValue off
     */
    fetchBridge?: FetchBridgeConfig;
}


/**
 * The configuration of strict mode (ADR-005): sealed mode's view and worker, with the network options. Guest code runs
 * only in a worker that a view document spawns, and the worker draws into the view with `sandboxView.render()`. `html`
 * is the initial view, rendered without its scripts and event-handler attributes.
 *
 * @remarks
 * `mode: 'strict'` must be named: a config that names no mode is sealed ({@link SealedSandboxConfig}, ADR-008), which
 * has no `origins` and no `fetchBridge`.
 */
export interface StrictSandboxConfig extends SandboxConfigOptions, NetworkSandboxOptions {
    /** Names the mode. */
    mode: 'strict';
    /** The origins the view's policy admits: as in the other modes, but without `scripts`, since the view runs only the library's bootstrap. */
    origins?: StrictSandboxOrigins;
    /** Not in strict mode (R1:R3-6): no capability reaches outside the view. Dropped at run time. */
    unsafeCapabilities?: never;
}


/**
 * The configuration of cooperative mode, for content that cooperates: guest code runs in the guest document, within the
 * documented limits of the mode (README, "Cooperative-mode limits"). `'iframe'` is not a mode: it is refused like any other unknown value.
 */
export interface CooperativeSandboxConfig extends SandboxConfigOptions, NetworkSandboxOptions {
    /** Names the mode. */
    mode: 'cooperative';
    /**
     * Capabilities that act outside the frame, from {@link UNSAFE_CAPABILITIES} (popups, modals, downloads, forms,
     * presentation, pointer lock, fullscreen): an explicit opt-in, and each one enabled warns once. Cooperative and worker mode only;
     * dropped with a warning in strict and sealed mode.
     *
     * @remarks
     * On Chromium the sandbox's frame is credentialless, so a popup that `allow-popups` lets the guest open has no
     * opener: the guest's `window.open()` returns `null`, though the page opens.
     *
     * @defaultValue `[]`
     */
    unsafeCapabilities?: UnsafeCapability[];
    /** Strict and sealed mode only (R1:R3-6): ignored with a warning at run time. */
    entry?: never;
    /** Strict and sealed mode only (the guest document is the guest's own): ignored with a warning at run time. */
    allowAnimations?: never;
    /** Strict and sealed mode only: ignored with a warning at run time. */
    allowAutoplay?: never;
    /** Worker, strict and sealed mode only (the guest document may share the host's thread, so no timer could fire; R1:R3-6): ignored. */
    workerExecutionTimeout?: never;
}


/**
 * The configuration of worker mode: guest code runs in a worker inside the frame. The mode is frozen and is to be folded
 * into strict mode (S49).
 */
export interface WorkerSandboxConfig extends SandboxConfigOptions, NetworkSandboxOptions {
    /** Names the mode. */
    mode: 'worker';
    /**
     * Capabilities that act outside the frame, from {@link UNSAFE_CAPABILITIES} (popups, modals, downloads, forms,
     * presentation, pointer lock, fullscreen): an explicit opt-in, and each one enabled warns once. Cooperative and worker mode only;
     * dropped with a warning in strict and sealed mode.
     *
     * @remarks
     * On Chromium the sandbox's frame is credentialless, so a popup that `allow-popups` lets the guest open has no
     * opener: the guest's `window.open()` returns `null`, though the page opens.
     *
     * @defaultValue `[]`
     */
    unsafeCapabilities?: UnsafeCapability[];
    /** Strict and sealed mode only (R1:R3-6): ignored with a warning at run time. */
    entry?: never;
    /** Strict and sealed mode only (a worker has no document): ignored with a warning at run time. */
    allowAnimations?: never;
    /** Strict and sealed mode only: ignored with a warning at run time. */
    allowAutoplay?: never;
    /** A worker has no document (R1:R3-6): ignored. */
    html?: never;
    /** A worker has no document to measure (R1:R3-6): no effect, with a warning at run time. */
    autoResize?: never;
}


/**
 * The events the network modes add to the element's ({@link WebSandboxEventMap}): in a build that has them, the
 * element's event map holds these too.
 */
export interface NetworkModeEvents {
    /**
     * A `sandboxFetch()` request settled, refusals included; see {@link FetchRecord}.
     *
     * @remarks
     * Dispatched only with `fetchBridge` configured, so only in a build with the network modes. Without it
     * `sandboxFetch()` rejects with `FETCH_NOT_ALLOWED` and no event is dispatched. Bubbles.
     */
    fetch: CustomEvent<FetchRecord>;
}

declare module '../host' {
    interface SandboxConfigByMode {
        /** Strict mode: sealed mode's view and worker, with the network options ({@link StrictSandboxConfig}). */
        strict: StrictSandboxConfig;
        /** Cooperative mode: guest code in the guest document ({@link CooperativeSandboxConfig}). */
        cooperative: CooperativeSandboxConfig;
        /** Worker mode: guest code in a worker inside the frame ({@link WorkerSandboxConfig}). */
        worker: WorkerSandboxConfig;
    }
    interface WebSandboxEventMap extends NetworkModeEvents {}
}
