/**
 * The seam between the element and the network modes (research 24, D9; ADR-009): what strict, cooperative and worker
 * mode, `origins` and `fetchBridge` give the element, as one interface, and the one slot that holds it.
 *
 * The default build never fills the slot: its entry (src/index.ts) imports no module that could, so `networkModes()`
 * is null there, the element has no method of the network modes, every call of one is skipped, and the config schema
 * refuses a config that asks for a network mode or option (config-schema.ts, networkModesOffRefusal). The network
 * build's entry (src/network.ts) installs the methods and fills the slot once, as it is imported, before any element
 * exists. Types only, and the slot: nothing of the network modes is imported here.
 *
 * Host-side only, never stringified into a guest.
 */
import type { CallBudget, NormaliseContext, OptionInput, StoredConfig } from './config-schema';
import type { TrustedTypesStance } from './csp/host-trusted-types';
import type { OriginPolicy } from './csp/origin-kinds';
import type { FileSnapshotEntry, FileStore } from './files';
import type { Generation, LcInput } from './lifecycle';
import type { LongTimeout } from './long-timer';
import type { LibraryDetail } from './reasons';
import type { Complete, Holds } from './utils';

/** What the host posts to a strict view with its two ports (INIT_VIEW). */
export interface StrictInit {
    workerSource: string;
    // The build's marker (entryDoneName): the worker's source ends the entry with its error, which tells the view the
    // entry ran to its end, in the order of the Worker object's errors (backlog S75; in-sandbox-view.ts).
    entryDone: string;
    viewFiles: FileSnapshotEntry[];
    html: string;
    autoResize: boolean;
    allowAnimations: boolean;
    allowAutoplay: boolean;
    // The origins the view's policy admits for the loads its markup makes, by kind key (R4:M-2): the
    // renderer drops an http(s) URL outside them, so the browser never processes a refusal. Sealed mode has no
    // origins, so its INIT_VIEW has no such field: the renderer then admits no http(s) URL at all.
    origins?: { images: readonly string[]; media: readonly string[] };
}

// What a strict view's build takes of the network options (network-host.ts, prepareStrictFrame), and sealed mode's takes
// nothing of (_prepareSealedFrame: null): the request gate and its list, the origins the renderer admits, the bridge's timeout.
export interface ViewNetwork {
    connect: string[];
    origins: OriginPolicy;
    fetchBridge: { timeoutMs: number } | null;
    /** The request gate's source (request-gate.ts, stringified): the bootstrap is given it, as sealed mode's never is. */
    requestGateSource: string;
}

// The network of a build of strict, cooperative or worker mode, as the element holds it: the fetch bridge's frame, its
// srcdoc written, not in the document (BD1:ISO-1), or null with the bridge off. What else the network modes prepared
// with it is theirs (network-host.ts).
export interface PreparedNetwork {
    bridgeFrame: HTMLIFrameElement | null;
}

// What a build prepared (_prepareBuild), until the reducer attaches it (`built`, then `attach`) or drops it (LM-2).
export interface PreparedBuild {
    iframe: HTMLIFrameElement; // the wrapper, its srcdoc written, not in the document
    built: FileStore; // the copy of the store this build delivers (BR:CB4)
    strictInit: StrictInit | null; // strict and sealed mode: what the wrapper's load hands the view
    network: PreparedNetwork | null; // the build's network, which _attachBuild starts; none in sealed mode
}

/** A request served by an environment's fetch bridge (fetch-bridge.ts, FetchBridge), as the reserved method reaches it. */
export interface FetchHandler {
    handle(request: unknown): Promise<unknown>;
    abortAll(): void;
}

/**
 * What the network modes' methods read, write and call of the element (host.ts): its own fields and methods, by their
 * names there. Nothing else of it is theirs.
 */
export interface NetworkHost {
    readonly shadowRoot: ShadowRoot | null;
    dispatchEvent(event: Event): boolean;
    _config: StoredConfig;
    _origins: OriginPolicy;
    _fetchPolicy: object | null;
    _callBudget: Readonly<CallBudget>;
    _hasMethods: boolean;
    _port: MessagePort | null;
    _queue: ({ code: string } | { frame: unknown })[];
    _fetchBridge: FetchHandler | null;
    _bridgeFrame: { close(): void } | null;
    _warnedBridgeFrame: boolean;
    _executionTimers: Set<LongTimeout>;
    _executionProbes: Map<number, () => void>;
    _probePings: number;
    readonly _lc: { readonly gen: Generation; readonly state: string; readonly started: boolean };
    _step(input: LcInput): void;
    _warnOnce(message: string): void;
    _autoResizeEnabled(): boolean;
    _refuseByTrustedTypes(): void;
    _trustedTypes(): TrustedTypesStance | null;
    _viewFileKinds(files: FileSnapshotEntry[]): Set<keyof OriginPolicy>;
    _prepareViewFrame(built: FileStore, files: FileSnapshotEntry[], policy: string, network: ViewNetwork | null): PreparedBuild;
    _onGuestMessage(port: MessagePort, reply: (frame: unknown) => void, data: unknown, source: 'logic' | null): void;
}

/** A frame the guest frame's window posted to the host page's window: the one announcement of cooperative and worker mode. */
export interface Announcement {
    readonly data: { readonly refused?: unknown };
    readonly ports: readonly MessagePort[];
    readonly trusted: boolean;
    readonly source: Window;
    readonly gen: Generation;
}

/**
 * The methods of the network modes that the element itself calls (network-host.ts, NetworkMethods, has them and the ones
 * they call): the network build installs them on the element's prototype, so an element has them exactly when its build
 * has the network modes.
 */
export interface NetworkElement {
    /** The build effect of strict, cooperative and worker mode: the wrapper and the build's network, detached. */
    _prepareNetworkBuild(built: FileStore, files: FileSnapshotEntry[]): PreparedBuild;
    /** Starts the fetch bridge of a build that prepared one, in its frame; null with the bridge off. */
    _startFetchBridge(network: PreparedNetwork): FetchHandler | null;
    /** The sandbox flags of a build of cooperative or worker mode (strict and sealed mode's are the view's). */
    _documentSandboxFlags(): string;
    /** The guest frame's announcement (cooperative and worker mode), handed to the reducer. */
    _onAnnouncement(announcement: Announcement): void;
    /** The announced port becomes the environment's (the reducer's `openChannel`). */
    setupChannel(port: MessagePort | null): void;
    /** One EXECUTE frame, with its budget armed first. */
    _postExecute(port: MessagePort, code: string): void;
    /** Whether a PONG answers an execution probe, which then passes. */
    _passExecutionProbe(n: unknown): boolean;
}

/** The names of those methods, as a value: what the install checks the network modes bring (network-install.ts). */
export const NETWORK_ELEMENT_METHODS = ['_prepareNetworkBuild', '_startFetchBridge', '_documentSandboxFlags', '_onAnnouncement', 'setupChannel', '_postExecute', '_passExecutionProbe'] as const satisfies readonly (keyof NetworkElement)[];
type NetworkElementMethodsComplete = Holds<Complete<keyof NetworkElement, typeof NETWORK_ELEMENT_METHODS>>;

/**
 * What the network modes give the library besides the element's methods: the build has them exactly when the slot holds
 * one of these.
 */
export interface NetworkModes {
    /** The config schema's rules of the options that open the network (config-schema.ts, NETWORK_OPTIONS). */
    readonly rules: { readonly origins: (input: OptionInput) => unknown; readonly fetchBridge: (input: OptionInput) => unknown };
    /** The host page as those rules read it (host-site.ts): its origin and the origins of its site. */
    readHostPage(): NormaliseContext;
    /** What the reason of a refused config says after the error's name: which `origins` list could not be read. */
    refusalDetail(error: unknown): LibraryDetail;
    /** The fetch bridge frame's part of the hashed bootstrap (in-sandbox-view.ts, viewBootstrapSource). */
    readonly bridgeBootstrap: string;
}

let installed: NetworkModes | null = null;

/** The network modes of this build, or null: the default build has none. */
export const networkModes = (): NetworkModes | null => installed;

/** Fills the slot. Called once, by the network build's entry as it is imported (network-install.ts), with the element's methods installed. */
export function installNetworkModes(modes: NetworkModes): void {
    installed = modes;
}
