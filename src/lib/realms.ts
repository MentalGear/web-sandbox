/**
 * The realms registry (S76): every realm the library runs in or hears from, the functions it stringifies into each,
 * and the channels each speaks on (src/lib/frames.ts, CHANNELS). One list, which the source scans of the stringified
 * code read (the frame-field scan, the capture-point scan, the read-once scan and the typeof-then-read scan, below) and
 * the generated docs render; test/unit/structural.test.ts checks that it names every function the library stringifies,
 * and the module that declares it.
 *
 * Data only, imported by tests and the docs: the library's own code takes nothing from it at run time.
 */
import type { EgressRealm } from './egress';
import type { ChannelId } from './frames';

export interface RealmRow {
    readonly summary: string;
    /** Whether guest code runs there. */
    readonly guestCode: boolean;
    /** Where the library builds the realm's source text from the stringified functions, or null for none. */
    readonly builder: string | null;
    readonly channels: readonly ChannelId[];
    /** The realm's name in the egress table (src/lib/egress.ts), or null where the table has no row for it. */
    readonly egress: EgressRealm | null;
}

export const REALMS = {
    'host': {
        summary: "The host page's window: the element, its listeners, and the host end of every port.",
        guestCode: false,
        builder: null,
        channels: ['announcement', 'logic-port', 'view-port', 'view-init', 'bridge-init', 'bridge-port'],
        egress: 'host',
    },
    'wrapper': {
        summary: "The sandbox frame's document (frame-documents.ts): it holds the guest frame or the strict view, and runs no script.",
        guestCode: false,
        builder: null,
        channels: [],
        egress: null,
    },
    'cooperative': {
        summary: "Cooperative mode's guest document: the bootstrap, then the guest's markup and scripts.",
        guestCode: true,
        builder: 'src/host.ts, _getSandboxCommsScript',
        channels: ['announcement', 'logic-port'],
        egress: 'cooperative',
    },
    'worker-frame': {
        summary: "Worker mode's frame document: it spawns the guest's worker and announces its port; no guest code or markup.",
        guestCode: false,
        builder: 'src/host.ts, _getWorkerBootstrapScript',
        channels: ['announcement', 'worker'],
        egress: 'frame',
    },
    'worker': {
        summary: "Worker mode's guest worker: the globals allowlist and the bootstrap, then the guest's code.",
        guestCode: true,
        builder: 'src/host.ts, _getWorkerBootstrapScript',
        channels: ['logic-port', 'worker'],
        egress: 'worker',
    },
    'view': {
        summary: "Strict mode's view document: it renders the guest's markup, spawns the guest's worker, and runs no guest code.",
        guestCode: false,
        builder: 'src/lib/in-sandbox-view.ts, viewBootstrapSource',
        channels: ['announcement', 'view-init', 'view-port', 'render-port', 'worker'],
        egress: 'view',
    },
    'strict-worker': {
        summary: "Strict mode's guest worker: the scope check, the globals allowlist, the bootstrap and the prelude, then the guest's entry.",
        guestCode: true,
        builder: 'src/host.ts, _getStrictWorkerSource',
        channels: ['logic-port', 'render-port', 'worker'],
        egress: 'worker',
    },
    'bridge-frame': {
        summary: "The fetch bridge's frame (bridge-frame.ts): a hidden frame of the element's with an opaque origin, which makes every request the host decided; no guest code or markup, and the guest has no handle on it.",
        guestCode: false,
        builder: 'src/lib/in-sandbox-view.ts, viewBootstrapSource',
        channels: ['announcement', 'bridge-init', 'bridge-port'],
        egress: 'bridge-frame',
    },
} as const satisfies Record<string, RealmRow>;

export type RealmId = keyof typeof REALMS;

/** A scan of the stringified code applies (true), or the reason it does not. */
export type Scan = true | string;

export interface StringifiedRow {
    /** The module that declares it. */
    readonly module: string;
    readonly realms: readonly RealmId[];
    /**
     * The capture-point scan (class G): after its captured list, the text names no
     * global and calls nothing through a prototype the guest can patch. It applies where the function's closures
     * outlive the start of guest code in a realm that runs it.
     */
    readonly capture: Scan;
    /** The read-once scan (class G; test/unit/read-once.test.ts): a property of one value is read once per function. */
    readonly readOnce: Scan;
    /** The typeof-then-read scan (R4:C-1): no `typeof x.p … x.p` in one statement. */
    readonly typeofRead: Scan;
}

const RUNS_FIRST = 'it runs to its end before any guest code, and leaves no closure behind';
const NO_GUEST = 'its realm runs no guest code';
const VIEW_STATEMENTS = "in-sandbox-view.ts's own: the typeof-then-read statement scan covers it";

/** Every function the library stringifies into a realm. */
export const STRINGIFIED = {
    inSandboxScript: { module: 'src/lib/in-sandbox-script.ts', realms: ['cooperative', 'worker', 'strict-worker'], capture: true, readOnce: true, typeofRead: true },
    createBroker: { module: 'src/lib/rpc.ts', realms: ['cooperative', 'worker', 'strict-worker'], capture: true, readOnce: true, typeofRead: true },
    createSizeOf: { module: 'src/lib/structured-size.ts', realms: ['cooperative', 'worker', 'strict-worker'], capture: true, readOnce: true, typeofRead: true },
    inSandboxFiles: { module: 'src/lib/in-sandbox-files.ts', realms: ['cooperative', 'worker', 'strict-worker', 'view'], capture: true, readOnce: true, typeofRead: true },
    inSandboxImportMap: { module: 'src/lib/in-sandbox-files.ts', realms: ['cooperative'], capture: RUNS_FIRST, readOnce: true, typeofRead: true },
    inSandboxMarkup: { module: 'src/lib/in-sandbox-files.ts', realms: ['cooperative'], capture: RUNS_FIRST, readOnce: true, typeofRead: true },
    keepOnlyWorkerGlobals: { module: 'src/lib/worker-globals.ts', realms: ['worker', 'strict-worker'], capture: RUNS_FIRST, readOnce: true, typeofRead: RUNS_FIRST },
    removeWebAssembly: { module: 'src/host.ts', realms: ['worker'], capture: RUNS_FIRST, readOnce: RUNS_FIRST, typeofRead: RUNS_FIRST },
    workerBootstrap: { module: 'src/lib/worker-bootstrap.ts', realms: ['worker-frame'], capture: NO_GUEST, readOnce: true, typeofRead: true },
    assertEntryScoped: { module: 'src/lib/in-sandbox-view.ts', realms: ['strict-worker'], capture: RUNS_FIRST, readOnce: VIEW_STATEMENTS, typeofRead: true },
    inStrictWorker: { module: 'src/lib/in-sandbox-view.ts', realms: ['strict-worker'], capture: true, readOnce: VIEW_STATEMENTS, typeofRead: true },
    inSandboxView: { module: 'src/lib/in-sandbox-view.ts', realms: ['view'], capture: NO_GUEST, readOnce: VIEW_STATEMENTS, typeofRead: true },
    sanitizeRender: { module: 'src/lib/in-sandbox-view.ts', realms: ['view'], capture: NO_GUEST, readOnce: VIEW_STATEMENTS, typeofRead: true },
    viewBudget: { module: 'src/lib/in-sandbox-view.ts', realms: ['view'], capture: NO_GUEST, readOnce: VIEW_STATEMENTS, typeofRead: true },
    cssLoadBound: { module: 'src/lib/in-sandbox-view.ts', realms: ['view'], capture: NO_GUEST, readOnce: VIEW_STATEMENTS, typeofRead: true },
    viewInputOutbox: { module: 'src/lib/in-sandbox-view.ts', realms: ['view'], capture: NO_GUEST, readOnce: VIEW_STATEMENTS, typeofRead: true },
    checkSandboxEnvironment: { module: 'src/lib/environment-check.ts', realms: ['cooperative', 'worker-frame', 'view', 'bridge-frame'], capture: RUNS_FIRST, readOnce: true, typeofRead: true },
    inBridgeFrame: { module: 'src/lib/in-bridge-frame.ts', realms: ['bridge-frame'], capture: NO_GUEST, readOnce: true, typeofRead: true },
} as const satisfies Record<string, StringifiedRow>;

export type StringifiedName = keyof typeof STRINGIFIED;

/** The stringified functions a scan applies to. */
export function scanned(scan: 'capture' | 'readOnce' | 'typeofRead'): StringifiedName[] {
    return (Object.keys(STRINGIFIED) as StringifiedName[]).filter(name => STRINGIFIED[name][scan] === true);
}
