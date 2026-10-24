/**
 * The frame table (S76): every channel the library's realms talk on, and every frame type that crosses one, declared
 * once, with its route (channel, from realm, to realm), its fields with what bounds each, and its purpose. The realms
 * are src/lib/realms.ts's.
 *
 * The functions stringified into a realm cannot import at run time, so they write the frame types as literals: those
 * are this table's mirror, and test/unit/structural.test.ts keeps the two equal. Every frame literal in src/ is a row
 * here, every row is used, and every field of every frame the stringified code posts is a field of its row (class
 * E-cpu: what a frame carries out of a guest realm or the view is cut, checked or measured before it is posted).
 *
 * Data only, imported by tests and the docs; the host takes only types from it.
 */
import type { RealmId } from './realms';

export interface ChannelRow {
    readonly kind: 'MessagePort' | 'window message' | 'worker message';
    readonly summary: string;
}

export const CHANNELS = {
    'announcement': { kind: 'window message', summary: "A library frame's message to the host page's window, before any port: the guest frame's one announcement (the logic port, or worker mode's refusal), and any bootstrap's refusal of an environment other than the one built." },
    'logic-port': { kind: 'MessagePort', summary: 'The host and the guest: calls both ways, execute(), liveness, and the guest bootstrap\'s lines and reports.' },
    'view-port': { kind: 'MessagePort', summary: "Strict mode: the host and the view, which runs no guest code; the view's check-in, reports and liveness." },
    'render-port': { kind: 'MessagePort', summary: "Strict mode: the view and the guest's worker; the host is not on this path." },
    'view-init': { kind: 'window message', summary: 'Strict mode: the host hands the view its two ports, once per build.' },
    'worker': { kind: 'worker message', summary: 'A frame and the worker it spawned: the worker gets its ports, and worker mode\'s worker says it started.' },
    'bridge-init': { kind: 'window message', summary: "The fetch bridge: the host hands the bridge's frame its port, once per build." },
    'bridge-port': { kind: 'MessagePort', summary: "The fetch bridge: the host and the bridge's frame, which makes every request the host decided; the guest is not on this path." },
} as const satisfies Record<string, ChannelRow>;

export type ChannelId = keyof typeof CHANNELS;

/**
 * What bounds a field's value:
 *   not a string   a number, a boolean, or nothing of the guest's
 *   constant       a string of the library's (a literal, a member of a closed set, a text built from constants and counts)
 *   cut            a string the guest chose, cut to a fixed length before it is posted
 *   checked        a value the guest chose, refused past a fixed size before anything is posted
 *   measured       a snapshot, measured whole against a byte budget before it is posted, its strings cut first
 *   host           the host's own value (the embedder's or the library's), sent into a realm; the guest never chose it
 */
export type FieldBound = 'not a string' | 'constant' | 'cut' | 'checked' | 'measured' | 'host';

export interface FrameField {
    readonly bound: FieldBound;
    /** The rule, naming its constants. */
    readonly how: string;
}

export interface FrameRoute {
    readonly channel: ChannelId;
    readonly from: readonly RealmId[];
    readonly to: readonly RealmId[];
}

export interface FrameRow {
    readonly purpose: string;
    readonly routes: readonly FrameRoute[];
    /** Every field besides `type`. */
    readonly fields: Readonly<Record<string, FrameField>>;
    /** How the receiver tells the frame, where it does not compare its type. */
    readonly receivedAs?: string;
}

const GUESTS = ['cooperative', 'worker', 'strict-worker'] as const;
const NUMBER = { bound: 'not a string', how: 'a number of the sender\'s, checked to be a number on receipt' } as const;
const NONE = {} as const;

export const FRAMES = {
    // ---- the announcement, and the worker's ports
    SANDBOX_PORT: {
        purpose: "The guest frame's announcement: the logic port, transferred; or why worker mode's worker could not start.",
        routes: [{ channel: 'announcement', from: ['cooperative', 'worker-frame'], to: ['host'] }],
        fields: { refused: { bound: 'constant', how: "worker mode's frame only: one of worker, trusted-types, failed" } },
    },
    ENVIRONMENT_REFUSED: {
        purpose: "A bootstrap found its document other than the one the library built (environment-check.ts) and stayed inert: the sandbox ends with the reason of the check that failed. No port.",
        routes: [{ channel: 'announcement', from: ['cooperative', 'worker-frame', 'view', 'bridge-frame'], to: ['host'] }],
        fields: { refused: { bound: 'constant', how: "one of the environment checks' ids (ENVIRONMENT_CHECKS: origin, url, base, isolated); the element takes its reason from its own table" } },
    },
    INIT_PORT: {
        purpose: "Worker mode's frame hands its worker the logic port.",
        routes: [{ channel: 'worker', from: ['worker-frame'], to: ['worker'] }],
        fields: NONE,
    },
    WORKER_STARTED: {
        purpose: "Worker mode's worker attached its port: the frame may announce it.",
        routes: [{ channel: 'worker', from: ['worker'], to: ['worker-frame'] }],
        fields: NONE,
    },
    INIT_VIEW: {
        purpose: "The host hands the view the logic and view ports, at the wrapper's load, with what the build shows.",
        routes: [{ channel: 'view-init', from: ['host'], to: ['view'] }],
        fields: {
            workerSource: { bound: 'host', how: "the worker's source: the prelude and the embedder's entry" },
            entryDone: { bound: 'host', how: "the build's marker of the entry's end, drawn by the host" },
            viewFiles: { bound: 'host', how: 'the registered files the view may show (no type that opens as a document)' },
            html: { bound: 'host', how: "the embedder's markup" },
            autoResize: { bound: 'host', how: "the embedder's switch" },
            allowAnimations: { bound: 'host', how: "the embedder's switch" },
            allowAutoplay: { bound: 'host', how: "the embedder's switch" },
            origins: { bound: 'host', how: "the policy's image and media origins" },
        },
    },
    INIT_WORKER: {
        purpose: "The view hands the guest's worker the logic port and the render port.",
        routes: [{ channel: 'worker', from: ['view'], to: ['strict-worker'] }],
        fields: NONE,
    },

    // ---- the logic port
    EXECUTE: {
        purpose: 'execute(): code for the guest to run.',
        routes: [{ channel: 'logic-port', from: ['host'], to: GUESTS }],
        fields: { code: { bound: 'host', how: "the embedder's string, as execute() took it" } },
    },
    PING: {
        purpose: "A liveness probe of the host's: the watchdog's (n > 0) or workerExecutionTimeout's (n < 0).",
        routes: [{ channel: 'logic-port', from: ['host'], to: GUESTS }],
        fields: { n: { bound: 'not a string', how: "the host's own counter" } },
    },
    PONG: {
        purpose: "The bootstrap's answer to a PING, before the broker: answering at all is the signal.",
        routes: [{ channel: 'logic-port', from: GUESTS, to: ['host'] }],
        fields: { n: NUMBER },
    },
    RPC_REQ: {
        purpose: 'A call: bridge.call() from the guest, call() from the host. Built by requestFrame only (rpc.ts).',
        routes: [{ channel: 'logic-port', from: GUESTS, to: ['host'] }, { channel: 'logic-port', from: ['host'], to: GUESTS }],
        fields: {
            id: { bound: 'not a string', how: "the broker's own counter" },
            method: { bound: 'checked', how: 'at most MAX_NAME_LENGTH (256) characters, else INVALID_CALL and nothing is posted' },
            args: { bound: 'measured', how: 'the snapshot, and the whole frame, against RPC_MAX_BYTES before it is posted' },
        },
    },
    RPC_RES: {
        purpose: "A call's answer, on the port its request came from. Built by resultFrame and refusalFrame only (rpc.ts).",
        routes: [{ channel: 'logic-port', from: GUESTS, to: ['host'] }, { channel: 'logic-port', from: ['host'], to: GUESTS }],
        fields: {
            id: { bound: 'checked', how: 'a number, or a string of at most MAX_NAME_LENGTH characters (isId), else the request is dropped' },
            ok: { bound: 'not a string', how: 'a boolean' },
            value: { bound: 'measured', how: 'the snapshot, and the whole frame, against RPC_MAX_BYTES before it is posted' },
            error: { bound: 'cut', how: 'to MAX_TEXT_LENGTH (65536) by the builder' },
            code: { bound: 'constant', how: "one of the broker's CODE constants" },
        },
    },
    LOG: {
        purpose: "A console line of the guest's, or one of the relay's own (`own`): sandbox-log.",
        routes: [{ channel: 'logic-port', from: GUESTS, to: ['host'] }],
        fields: {
            level: { bound: 'constant', how: 'one of log, info, warn, error' },
            args: { bound: 'measured', how: "the guest's: safeArgs, at most LOG_MAX_ARGS, each string cut at LOG_MAX_STRING, the rest measured against LOG_MAX_BYTES; the relay's own: built from constants and counts" },
            own: { bound: 'not a string', how: "true on the relay's own lines" },
        },
    },
    VIOLATION: {
        purpose: 'A Content-Security-Policy violation report: violation. Labelled by the port it arrived on in strict mode.',
        routes: [{ channel: 'logic-port', from: GUESTS, to: ['host'] }, { channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: {
            directive: { bound: 'cut', how: "at VIOLATION_MAX_STRING (2048), the browser's directive name; the host takes it only if it matches /^[a-z][a-z-]{0,63}$/ (violation.ts)" },
            blockedURI: { bound: 'cut', how: "at VIOLATION_MAX_STRING (2048), the browser's report of a URL the guest chose; cut again on receipt (violation.ts), at most VIOLATION_EVENT_LIMIT per environment (the view's: per directive)" },
            sourceFile: { bound: 'cut', how: 'as blockedURI' },
            lineNumber: { bound: 'not a string', how: "the browser's number (the host keeps a positive integer only)" },
            columnNumber: { bound: 'not a string', how: 'as lineNumber' },
        },
    },
    RESIZE: {
        purpose: "The content's height, for autoResize: from cooperative mode's bootstrap, or strict mode's view.",
        routes: [{ channel: 'logic-port', from: ['cooperative'], to: ['host'] }, { channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: { height: { bound: 'not a string', how: 'a measured height (the host clamps it at AUTO_RESIZE_MAX_HEIGHT)' } },
    },
    UNCAUGHT_PAST_BUDGET: {
        purpose: "The guest raised more uncaught errors and rejections in a second than their budget: the sandbox ends.",
        routes: [{ channel: 'logic-port', from: ['worker', 'strict-worker'], to: ['host'] }, { channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: NONE,
    },

    // ---- the view port
    VIEW_READY: {
        purpose: "The view's check-in, its first frame: the strict build is ready.",
        routes: [{ channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: {
            width: { bound: 'not a string', how: "the view's own window" },
            height: { bound: 'not a string', how: "the view's own window" },
            stillStyleRefused: { bound: 'not a string', how: "true when the host page's style-src refused the still stylesheet" },
        },
    },
    VIEW_PING: {
        purpose: "The view's liveness probe (VIEW_LIVENESS_TIMEOUT_MS).",
        routes: [{ channel: 'view-port', from: ['host'], to: ['view'] }],
        fields: { n: { bound: 'not a string', how: "the host's own counter" } },
    },
    VIEW_PONG: {
        purpose: "The view's answer to a VIEW_PING.",
        routes: [{ channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: { n: NUMBER },
    },
    VIEW_WRITE: {
        purpose: 'A guest write the host recorded, for the view to show (a raster image gets a URL of its own there).',
        routes: [{ channel: 'view-port', from: ['host'], to: ['view'] }],
        fields: {
            id: { bound: 'host', how: "the host's own counter" },
            path: { bound: 'host', how: 'a path the host checked (files.ts, MAX_PATH_LENGTH)' },
            mime: { bound: 'host', how: "the file's type, or null for a removal" },
            bytes: { bound: 'host', how: 'a copy of the written bytes for a raster image type (VIEW_WRITE_TYPES), else null' },
        },
    },
    VIEW_WRITTEN: {
        purpose: 'The view shows the write: the guest may now be told it stands.',
        routes: [{ channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: { id: NUMBER },
    },
    VIEW_FIRST_OVERRUN: {
        purpose: "An operation of the view overran VIEW_MAX_OPERATION_MS, with no other in the window: one host line an environment.",
        routes: [{ channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: NONE,
    },
    VIEW_OVERRUN: {
        purpose: 'A second overrun within VIEW_OVERRUN_WINDOW_MS: the sandbox ends.',
        routes: [{ channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: NONE,
    },
    GUEST_ERROR: {
        purpose: "The entry failed to start, with its error text: the sandbox ends, and the text follows as a guest line.",
        routes: [{ channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: { message: { bound: 'cut', how: 'to guestText.maxLength (2048), at most LOG_EVENTS_PER_SECOND a second' } },
    },
    GUEST_UNCAUGHT: {
        purpose: "A later uncaught error of the worker's that only the view can describe: a guest line.",
        routes: [{ channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: { message: { bound: 'cut', how: 'as GUEST_ERROR' } },
    },
    GUEST_TEXT_DROPPED: {
        purpose: 'The view dropped a guest error text past its per-second window: one warn line an environment.',
        routes: [{ channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: NONE,
    },
    TRUSTED_TYPES_REFUSED: {
        purpose: "The host page's trusted-types directive does not name the view's policy: the build ends.",
        routes: [{ channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: NONE,
    },
    WORKER_REFUSED: {
        purpose: "The host page's policy refuses the view's blob: worker: the build ends.",
        routes: [{ channel: 'view-port', from: ['view'], to: ['host'] }],
        fields: NONE,
    },

    // ---- the render port
    VIEW_STARTED: {
        purpose: "The worker's prelude holds the render port: the view revokes the worker's source URL. Always its first frame.",
        routes: [{ channel: 'render-port', from: ['strict-worker'], to: ['view'] }],
        fields: NONE,
        receivedAs: 'the first frame on the render port, whatever its type',
    },
    VIEW_RENDER: {
        purpose: 'sandboxView.render(): markup for the view to clean and show.',
        routes: [{ channel: 'render-port', from: ['strict-worker'], to: ['view'] }],
        fields: {
            html: { bound: 'checked', how: 'at most VIEW_RENDER_MAX_LENGTH characters, else render() throws' },
            into: { bound: 'checked', how: 'an id of at most VIEW_TARGET_MAX_LENGTH characters, or null' },
        },
    },
    VIEW_TEXT: {
        purpose: "sandboxView.text(): an element's text, as one text node.",
        routes: [{ channel: 'render-port', from: ['strict-worker'], to: ['view'] }],
        fields: {
            into: { bound: 'checked', how: 'an id of at most VIEW_TARGET_MAX_LENGTH characters' },
            text: { bound: 'checked', how: 'at most VIEW_RENDER_MAX_LENGTH characters, else text() throws' },
        },
    },
    VIEW_SET: {
        purpose: "sandboxView.set(): a form control's value or checked state, focus, or an element's scroll position or inline style.",
        routes: [{ channel: 'render-port', from: ['strict-worker'], to: ['view'] }],
        fields: {
            id: { bound: 'checked', how: 'an id of at most VIEW_TARGET_MAX_LENGTH characters' },
            value: { bound: 'checked', how: 'set by key after the literal: at most VIEW_RENDER_MAX_LENGTH characters, else set() throws' },
            checked: { bound: 'not a string', how: 'set by key after the literal: a boolean' },
            focus: { bound: 'not a string', how: 'set by key after the literal: true' },
            scroll: { bound: 'not a string', how: 'set by key after the literal: { top?, left? }, finite numbers, read once' },
            css: { bound: 'checked', how: 'set by key after the literal: at most VIEW_SET_STYLE_LIMITS.maxProperties properties of VIEW_STYLE_PROPERTIES, each value a string of at most VIEW_SET_STYLE_LIMITS.maxValue characters or null, else set() throws; read once' },
        },
    },
    VIEW_LISTEN: {
        purpose: "The event types the worker's sandboxView.on() handlers listen to, and the elements their options name (pointerCapture, rect, preventDefault).",
        routes: [{ channel: 'render-port', from: ['strict-worker'], to: ['view'] }],
        fields: {
            types: { bound: 'constant', how: 'members of VIEW_EVENT_TYPES' },
            marks: { bound: 'checked', how: '[type, id | null, flags] for the handlers with options: a member of VIEW_EVENT_TYPES, an id of at most VIEW_TARGET_MAX_LENGTH characters, flags 1–7; at most VIEW_EVENT_LIMITS.maxIds ids a type, else on() throws' },
        },
    },
    VIEW_ACK: {
        purpose: "The view applied a flush of operations: the worker's next one may go. What it refused, by name.",
        routes: [{ channel: 'render-port', from: ['view'], to: ['strict-worker'] }],
        fields: { refused: { bound: 'constant', how: 'names from a fixed list (VIEW_MAX_ELEMENTS …)' } },
    },
    VIEW_EVENT: {
        purpose: 'Events of the types the worker listens to, as details, in the order they were raised: a discrete one behind the continuous ones the view coalesced before it, or those alone (at most one such frame unacknowledged, VIEW_INPUT_IN_FLIGHT).',
        routes: [{ channel: 'render-port', from: ['view'], to: ['strict-worker'] }],
        fields: { details: { bound: 'cut', how: 'every string of them through clamp, at most VIEW_EVENT_LIMITS.maxString each and maxTotal together for the frame; ids and form fields capped; the rest numbers and constants, coordinates clamped to the view; the rectangles a rect option asked for, by the ids of VIEW_LISTEN\'s marks' } },
    },
    VIEW_EVENT_ACK: {
        purpose: "The worker's prelude dispatched a VIEW_EVENT and its handlers have returned: the view may send the next continuous events.",
        routes: [{ channel: 'render-port', from: ['strict-worker'], to: ['view'] }],
        fields: NONE,
    },

    // ---- the fetch bridge's frame (BD1:ISO-1): the host decides each request, the frame makes it
    BRIDGE_INIT: {
        purpose: "The host hands the fetch bridge's frame its port, at the frame's load.",
        routes: [{ channel: 'bridge-init', from: ['host'], to: ['bridge-frame'] }],
        fields: { maxBytes: { bound: 'host', how: '`fetchBridge.maxBytes`: past it the frame posts no further chunk of a body' } },
    },
    BRIDGE_READY: {
        purpose: "The bridge frame's check-in, its first frame: the frame holds its port. None within LOAD_TIMEOUT_MS: the bridge refuses every request.",
        routes: [{ channel: 'bridge-port', from: ['bridge-frame'], to: ['host'] }],
        fields: NONE,
    },
    BRIDGE_FETCH: {
        purpose: 'A request the host checked (fetch-bridge.ts), for the frame to make with BRIDGE_REQUEST_OPTIONS.',
        routes: [{ channel: 'bridge-port', from: ['host'], to: ['bridge-frame'] }],
        fields: {
            id: { bound: 'host', how: "the host's own counter" },
            url: { bound: 'host', how: 'the URL the bridge checked, at most MAX_URL characters' },
            method: { bound: 'host', how: 'a method the policy admits' },
            headers: { bound: 'host', how: 'the header pairs the policy admits' },
            body: { bound: 'host', how: 'the request body the bridge checked, at most `fetchBridge.maxBytes`' },
        },
    },
    BRIDGE_PULL: {
        purpose: "The bridge reads the next chunk of a response's body: one a pull.",
        routes: [{ channel: 'bridge-port', from: ['host'], to: ['bridge-frame'] }],
        fields: { id: { bound: 'host', how: "the host's own counter" } },
    },
    BRIDGE_ABORT: {
        purpose: 'The host ended a request (its timeout, a refusal, a teardown): the frame aborts its fetch.',
        routes: [{ channel: 'bridge-port', from: ['host'], to: ['bridge-frame'] }],
        fields: { id: { bound: 'host', how: "the host's own counter" } },
    },
    BRIDGE_HEAD: {
        purpose: "A response's head, as the frame received it: the host decides on it (a redirect, the declared length).",
        routes: [{ channel: 'bridge-port', from: ['bridge-frame'], to: ['host'] }],
        fields: {
            id: NUMBER,
            responseType: { bound: 'constant', how: "the platform's Response type, a member of its closed set" },
            status: NUMBER,
            statusText: { bound: 'checked', how: 'with the headers, at most MAX_RESPONSE_HEAD characters, else BRIDGE_ERROR (FETCH_TOO_LARGE) and nothing of the head is posted' },
            headers: { bound: 'checked', how: 'names and values, with statusText at most MAX_RESPONSE_HEAD characters together' },
            hasBody: { bound: 'not a string', how: 'a boolean' },
        },
    },
    BRIDGE_CHUNK: {
        purpose: "The next chunk of a response's body, in answer to a BRIDGE_PULL.",
        routes: [{ channel: 'bridge-port', from: ['bridge-frame'], to: ['host'] }],
        fields: {
            id: NUMBER,
            chunk: { bound: 'checked', how: "bytes the browser read, one chunk a BRIDGE_PULL, and none once the request's total passed BRIDGE_INIT's maxBytes: at most maxBytes and one chunk a request" },
        },
    },
    BRIDGE_END: {
        purpose: "A response's body ended.",
        routes: [{ channel: 'bridge-port', from: ['bridge-frame'], to: ['host'] }],
        fields: { id: NUMBER },
    },
    BRIDGE_ERROR: {
        purpose: 'A request failed in the frame: the network or CORS, a head too large, or a Request the browser refused.',
        routes: [{ channel: 'bridge-port', from: ['bridge-frame'], to: ['host'] }],
        fields: { id: NUMBER, code: { bound: 'constant', how: 'one of FETCH_FAILED, FETCH_TOO_LARGE, FETCH_NOT_ALLOWED' } },
    },
} as const satisfies Record<string, FrameRow>;

export type FrameType = keyof typeof FRAMES;

/** The frame types that cross `channel`. */
export type FrameOn<C extends ChannelId> = {
    [T in FrameType]: (typeof FRAMES)[T]['routes'][number]['channel'] extends infer K ? (C extends K ? T : never) : never;
}[FrameType];

/** The fields of a frame type, `type` included. */
export type FrameFields<T extends FrameType> = 'type' | keyof (typeof FRAMES)[T]['fields'];
