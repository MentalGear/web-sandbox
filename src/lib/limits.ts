/**
 * The limits registry (S76): every numeric bound the docs state, once, with its value, what it bounds and where it is
 * enforced. docs/API.md's Limits table lists the rows with a `label`, and its Budgets table (egress.ts,
 * CHANNEL_BUDGETS) names constants by their key here: test/unit/api-docs.test.ts and test/unit/budgets.test.ts read
 * both tables against this registry, so a limit added, removed or changed shows in the docs or fails there.
 *
 * A value is imported from the module that declares it. Some live only inside a function stringified into a realm,
 * which cannot import: their rows hold the value, and `mirror` names the constant there, which
 * test/unit/api-docs.test.ts keeps equal to it (the pattern of every constant mirrored into stringified code).
 *
 * Data only, imported by tests and the docs.
 */
import { EXECUTION_TIMEOUT_GRACE_MS, LOAD_TIMEOUT_MS, VIEW_LIVENESS_TIMEOUT_MS } from '../host';
import { AUTO_RESIZE_MAX_HEIGHT, AUTO_RESIZE_MAX_UPDATES_PER_SECOND } from './auto-resize';
import { GUEST_CALL_BYTES_PER_SECOND, GUEST_CALLS_PER_SECOND } from './config-schema';
import { UNCAUGHT_CHARACTERS_PER_SECOND, UNCAUGHT_PER_SECOND } from './egress';
import { DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_MAX_BYTES, DEFAULT_MAX_CONCURRENT, MAX_MAX_BYTES, MAX_MAX_CONCURRENT, MAX_TIMEOUT_MS, MAX_URL } from './fetch-bridge';
import { MAX_FILES, MAX_PATH_LENGTH, MAX_TOTAL_BYTES } from './files';
import { MAX_RESPONSE_HEAD } from './in-bridge-frame';
import { GUEST_WRITE_BYTES_PER_SECOND, GUEST_WRITES_PER_SECOND } from './guest-writes';
import {
    VIEW_APPLY_MS_PER_SECOND, VIEW_EVENT_LIMITS, VIEW_INPUT_IN_FLIGHT, VIEW_MAX_CHARACTERS, VIEW_MAX_DEPTH, VIEW_MAX_DISTINCT_URLS, VIEW_MAX_ELEMENTS,
    VIEW_MAX_OPERATION_MS, VIEW_MAX_URLS, VIEW_OPTIONS, VIEW_OVERRUN_WINDOW_MS, VIEW_RENDER_CHARACTERS_PER_SECOND,
    VIEW_RENDER_MAX_LENGTH, VIEW_TARGET_MAX_LENGTH, VIEW_URLS_PER_SECOND,
} from './in-sandbox-view';
import { MAX_INBOUND_IN_FLIGHT, RPC_MAX_BYTES, RPC_MAX_INBOUND_BYTES } from './rpc';
import { LOG_BYTES_PER_SECOND, LOG_EVENTS_PER_SECOND, LOG_MAX_ARGS, LOG_MAX_BYTES, LOG_MAX_STRING } from './sandbox-log';
import { VIOLATION_EVENT_LIMIT, VIOLATION_MAX_STRING } from './violation';

export type LimitUnit = 'count' | 'bytes' | 'characters' | 'ms' | 'px';

export interface LimitRow {
    readonly value: number;
    readonly unit: LimitUnit;
    /** What it bounds: its row in docs/API.md's Limits table, or null where only the Budgets table names it. */
    readonly label: string | null;
    /** Said after the value in the Limits table. */
    readonly note?: string;
    /** Where the library enforces it. */
    readonly enforced: string;
    /** Exported by the package (src/index.ts) under its key. */
    readonly exported: boolean;
    /** The constant inside a stringified function that holds the value: [module, name]. */
    readonly mirror?: readonly [module: string, name: string];
}

const RPC = 'rpc.ts, createBroker, at both ends';
const RELAY = 'in-sandbox-script.ts, the console relay, before posting; sandbox-log.ts, toLogDetail, again on receipt';
const VIEW = 'in-sandbox-view.ts, the view (inSandboxView)';
const PRELUDE = 'in-sandbox-view.ts, the strict prelude (inStrictWorker), before posting; the view again on receipt';
const FILES = 'files.ts, FileStore, for the registered files and the guest writes together';
const FETCH = 'fetch-bridge.ts, toFetchPolicy';

export const LIMITS = {
    MAX_INBOUND_IN_FLIGHT: { value: MAX_INBOUND_IN_FLIGHT, unit: 'count', label: 'Inbound calls running at once, per side and environment', enforced: `${RPC}; in-sandbox-script.ts, the calls held until the guest document is parsed`, exported: true },
    GUEST_CALLS_PER_SECOND: { value: GUEST_CALLS_PER_SECOND, unit: 'count', label: 'Guest calls per second, per environment (any one-second window; default of `callLimits.maxPerSecond`)', enforced: "config-schema.ts, admitGuestCall: the host, and the guest's broker by the same rule", exported: false },
    GUEST_CALL_BYTES_PER_SECOND: { value: GUEST_CALL_BYTES_PER_SECOND, unit: 'bytes', label: 'Bytes of guest calls per second, per environment (any one-second window; default of `callLimits.maxBytesPerSecond`)', enforced: "config-schema.ts, admitGuestCall: the host, and the guest's broker by the same rule", exported: false },
    DEFAULT_TIMEOUT_MS: { value: 30000, unit: 'ms', label: 'Default call timeout (ms)', enforced: 'rpc.ts, createBroker, callWithTimeout', exported: false, mirror: ['src/lib/rpc.ts', 'DEFAULT_TIMEOUT_MS'] },
    BLOB_TYPE_MAX_LENGTH: { value: 4096, unit: 'characters', label: "Characters of a `Blob`'s or `File`'s `type` (longer is over every byte budget, on every engine)", enforced: 'structured-size.ts, the byte measure, at both ends of a message and a log line', exported: false, mirror: ['src/lib/structured-size.ts', 'BLOB_TYPE_MAX_LENGTH'] },
    MAX_NAME_LENGTH: { value: 256, unit: 'characters', label: 'Characters of a method name', enforced: RPC, exported: false, mirror: ['src/lib/rpc.ts', 'MAX_NAME_LENGTH'] },
    MAX_TEXT_LENGTH: { value: 65536, unit: 'characters', label: 'Characters of an error message a call carries', enforced: RPC, exported: false, mirror: ['src/lib/rpc.ts', 'MAX_TEXT_LENGTH'] },
    LOG_EVENTS_PER_SECOND: { value: LOG_EVENTS_PER_SECOND, unit: 'count', label: 'Guest log lines per second, per environment', enforced: 'in-sandbox-script.ts, the console relay; host.ts, the log limiter, again on receipt', exported: true },
    LOG_BUFFER_LIMIT: { value: LOG_EVENTS_PER_SECOND, unit: 'count', label: 'Guest log lines kept until the guest is connected', note: 'and 4 MiB', enforced: 'in-sandbox-script.ts, the console relay, before the port is attached: one window of LOG_EVENTS_PER_SECOND lines and LOG_BYTES_PER_SECOND bytes', exported: false, mirror: ['src/lib/in-sandbox-script.ts', 'LOG_LINES_PER_SECOND'] },
    LOG_MAX_ARGS: { value: LOG_MAX_ARGS, unit: 'count', label: 'Arguments kept per log line', enforced: RELAY, exported: true },
    LOG_MAX_STRING: { value: LOG_MAX_STRING, unit: 'characters', label: 'Characters kept per string log argument', enforced: RELAY, exported: true },
    LOG_MAX_BYTES: { value: LOG_MAX_BYTES, unit: 'bytes', label: 'Bytes per log line, all arguments together', enforced: RELAY, exported: false },
    LOG_BYTES_PER_SECOND: { value: LOG_BYTES_PER_SECOND, unit: 'bytes', label: 'Bytes of guest log lines sent per second', enforced: 'in-sandbox-script.ts, the console relay', exported: false },
    UNCAUGHT_PER_SECOND: { value: UNCAUGHT_PER_SECOND, unit: 'count', label: 'Uncaught errors and unhandled rejections per second, per environment (worker and strict mode; rejections handled later included); past it the sandbox ends', enforced: "in-sandbox-script.ts, the uncaught budget (host.ts hands it UNCAUGHT_BUDGET); host.ts ends the sandbox at its UNCAUGHT_PAST_BUDGET", exported: false },
    UNCAUGHT_CHARACTERS_PER_SECOND: { value: UNCAUGHT_CHARACTERS_PER_SECOND, unit: 'characters', label: 'Characters of uncaught errors and unhandled rejections per second, per environment (worker and strict mode; their names and messages); past it the sandbox ends', enforced: 'as UNCAUGHT_PER_SECOND', exported: false },
    RPC_MAX_BYTES: { value: RPC_MAX_BYTES, unit: 'bytes', label: 'Bytes per RPC message (arguments, or a result)', enforced: RPC, exported: false },
    RPC_MAX_INBOUND_BYTES: { value: RPC_MAX_INBOUND_BYTES, unit: 'bytes', label: 'Bytes of arguments in inbound calls running at once, per side and environment', enforced: RPC, exported: false },
    VIOLATION_EVENT_LIMIT: { value: VIOLATION_EVENT_LIMIT, unit: 'count', label: '`violation` events per environment (strict mode: per source, and per directive for the view)', enforced: 'host.ts, _dispatchViolation; the bootstrap and the view, before posting', exported: true },
    VIOLATION_MAX_STRING: { value: VIOLATION_MAX_STRING, unit: 'characters', label: null, enforced: 'in-sandbox-script.ts and the view, before posting; violation.ts, toViolationDetail, again on receipt', exported: false },
    AUTO_RESIZE_MAX_HEIGHT: { value: AUTO_RESIZE_MAX_HEIGHT, unit: 'px', label: 'Auto-size: tallest height (px)', enforced: 'auto-resize.ts, the host', exported: true },
    AUTO_RESIZE_MAX_UPDATES_PER_SECOND: { value: AUTO_RESIZE_MAX_UPDATES_PER_SECOND, unit: 'count', label: 'Auto-size: height changes per second (and at most one per frame)', enforced: 'auto-resize.ts, the host', exported: true },
    VIEW_RENDER_MAX_LENGTH: { value: VIEW_RENDER_MAX_LENGTH, unit: 'characters', label: 'Strict: characters per `sandboxView.render()`, `text()` or `set()` value', enforced: PRELUDE, exported: true },
    VIEW_TARGET_MAX_LENGTH: { value: VIEW_TARGET_MAX_LENGTH, unit: 'characters', label: 'Strict: characters of a render or event target id', enforced: PRELUDE, exported: false },
    VIEW_MAX_ELEMENTS: { value: VIEW_MAX_ELEMENTS, unit: 'count', label: 'Strict: elements in the view', enforced: `${VIEW}, sanitizeRender`, exported: false },
    VIEW_MAX_CHARACTERS: { value: VIEW_MAX_CHARACTERS, unit: 'characters', label: 'Strict: characters in the view (its body\'s serialization)', enforced: VIEW, exported: false },
    VIEW_RENDER_CHARACTERS_PER_SECOND: { value: VIEW_RENDER_CHARACTERS_PER_SECOND, unit: 'characters', label: 'Strict: characters of markup the view parses per second', enforced: `${VIEW}, viewBudget`, exported: false },
    VIEW_APPLY_MS_PER_SECOND: { value: VIEW_APPLY_MS_PER_SECOND, unit: 'ms', label: 'Strict: time the view spends applying operations per second, their layout and rendering included (ms)', enforced: `${VIEW}, viewBudget`, exported: false },
    VIEW_MAX_OPERATION_MS: { value: VIEW_MAX_OPERATION_MS, unit: 'ms', label: 'Strict: longest operation of the view, its layout and rendering included (ms; a longer one is an overrun, and the second within the next row\'s window ends the sandbox)', enforced: `${VIEW}, viewBudget; host.ts ends the sandbox at its VIEW_OVERRUN`, exported: false },
    VIEW_OVERRUN_WINDOW_MS: { value: VIEW_OVERRUN_WINDOW_MS, unit: 'ms', label: 'Strict: window of the view\'s repeated-overrun rule (ms, from the first of two overruns)', enforced: `${VIEW}, viewBudget`, exported: false },
    VIEW_MAX_URLS: { value: VIEW_MAX_URLS, unit: 'count', label: 'Strict: URL-bearing attributes in the view (`src`, `srcset`, `poster`, `<link>`\'s `href`)', enforced: `${VIEW}, sanitizeRender`, exported: false },
    VIEW_URLS_PER_SECOND: { value: VIEW_URLS_PER_SECOND, unit: 'count', label: 'Strict: loads of the view per second (URL-bearing attributes rendered, and every other load or refused load the browser reports)', enforced: `${VIEW}, viewBudget`, exported: false },
    VIEW_MAX_DISTINCT_URLS: { value: VIEW_MAX_DISTINCT_URLS, unit: 'count', label: 'Strict: distinct URLs one view loads, over its life', enforced: VIEW, exported: false },
    VIEW_MAX_DEPTH: { value: VIEW_MAX_DEPTH, unit: 'count', label: 'Strict: nesting depth below the view\'s body', enforced: `${VIEW}, sanitizeRender`, exported: false },
    'VIEW_EVENT_LIMITS.maxTotal': { value: VIEW_EVENT_LIMITS.maxTotal, unit: 'characters', label: 'Strict: characters of one event detail, all strings together', enforced: `${VIEW}, before posting a VIEW_EVENT`, exported: false },
    'VIEW_EVENT_LIMITS.maxString': { value: VIEW_EVENT_LIMITS.maxString, unit: 'characters', label: null, enforced: `${VIEW}, before posting a VIEW_EVENT`, exported: false },
    'VIEW_EVENT_LIMITS.maxIds': { value: VIEW_EVENT_LIMITS.maxIds, unit: 'count', label: null, enforced: `${VIEW}, before posting a VIEW_EVENT`, exported: false },
    'VIEW_EVENT_LIMITS.maxFields': { value: VIEW_EVENT_LIMITS.maxFields, unit: 'count', label: null, enforced: `${VIEW}, before posting a VIEW_EVENT`, exported: false },
    VIEW_INPUT_IN_FLIGHT: { value: VIEW_INPUT_IN_FLIGHT, unit: 'count', label: "Strict: frames of the view's events the worker has not acknowledged, past which the view holds pointer moves, wheel and scroll events back, coalesced (at most one per pointer or element, sent at most once per animation frame)", enforced: `${VIEW}, the input outbox (viewInputOutbox); the strict prelude acknowledges each frame (VIEW_EVENT_ACK)`, exported: true },
    'VIEW_OPTIONS.guestText.maxLength': { value: VIEW_OPTIONS.guestText.maxLength, unit: 'characters', label: null, enforced: `${VIEW}, before posting a GUEST_ERROR or GUEST_UNCAUGHT; host.ts, again on receipt`, exported: false },
    VIEW_LIVENESS_TIMEOUT_MS: { value: VIEW_LIVENESS_TIMEOUT_MS, unit: 'ms', label: 'Strict: view liveness budget (ms)', enforced: "host.ts, the view's watchdog (watchdog.ts)", exported: true },
    LOAD_TIMEOUT_MS: { value: LOAD_TIMEOUT_MS, unit: 'ms', label: 'Longest `loading`, until the guest checks in (ms of host time)', enforced: 'lifecycle.ts, loadDeadline; host.ts arms it (watchdog.ts)', exported: true },
    EXECUTION_TIMEOUT_GRACE_MS: { value: EXECUTION_TIMEOUT_GRACE_MS, unit: 'ms', label: '`workerExecutionTimeout`: how long the event loop may stay busy past a deadline (ms)', enforced: 'host.ts, _probeExecution (watchdog.ts)', exported: true },
    MAX_TOTAL_BYTES: { value: MAX_TOTAL_BYTES, unit: 'bytes', label: 'Files: total bytes', enforced: FILES, exported: false },
    MAX_FILES: { value: MAX_FILES, unit: 'count', label: 'Files: count', enforced: FILES, exported: false },
    MAX_PATH_LENGTH: { value: MAX_PATH_LENGTH, unit: 'characters', label: 'Files: path length', enforced: 'files.ts, the path check', exported: false },
    DEFAULT_MAX_BYTES: { value: DEFAULT_MAX_BYTES, unit: 'bytes', label: 'Fetch: default `maxBytes`', enforced: FETCH, exported: false },
    MAX_MAX_BYTES: { value: MAX_MAX_BYTES, unit: 'bytes', label: 'Fetch: largest `maxBytes`', enforced: FETCH, exported: false },
    DEFAULT_FETCH_TIMEOUT_MS: { value: DEFAULT_FETCH_TIMEOUT_MS, unit: 'ms', label: 'Fetch: default `timeoutMs`', enforced: FETCH, exported: false },
    MAX_TIMEOUT_MS: { value: MAX_TIMEOUT_MS, unit: 'ms', label: 'Fetch: largest `timeoutMs`', enforced: FETCH, exported: false },
    DEFAULT_MAX_CONCURRENT: { value: DEFAULT_MAX_CONCURRENT, unit: 'count', label: 'Fetch: default `maxConcurrent`', enforced: FETCH, exported: false },
    MAX_MAX_CONCURRENT: { value: MAX_MAX_CONCURRENT, unit: 'count', label: 'Fetch: largest `maxConcurrent`', enforced: FETCH, exported: false },
    MAX_URL: { value: MAX_URL, unit: 'characters', label: 'Fetch: characters of a URL, as written and as parsed', enforced: 'fetch-bridge.ts, the request check', exported: false },
    MAX_RESPONSE_HEAD: { value: MAX_RESPONSE_HEAD, unit: 'characters', label: "Fetch: characters of a response's status text and headers, together", enforced: "in-bridge-frame.ts, the bridge's frame, before it posts the head", exported: false },
    GUEST_WRITES_PER_SECOND: { value: GUEST_WRITES_PER_SECOND, unit: 'count', label: 'Guest writes: requests per second, per environment', enforced: 'guest-writes.ts, the host', exported: true },
    GUEST_WRITE_BYTES_PER_SECOND: { value: GUEST_WRITE_BYTES_PER_SECOND, unit: 'bytes', label: 'Guest writes: bytes per second, per environment', enforced: 'guest-writes.ts, the host', exported: true },
} as const satisfies Record<string, LimitRow>;

export type LimitName = keyof typeof LIMITS;

/**
 * A limit's value as a literal type: the type of a constant mirrored into stringified code (`const MAX: LimitValue<'X'>
 * = 256`), which compiles only while the two are equal. Types erase, so the stringified text is the literal alone.
 */
export type LimitValue<K extends LimitName> = (typeof LIMITS)[K]['value'];

/** Every limit's value by its key: what the Budgets table's `{NAME}` cells are rendered with (egress.ts, budgetsTable). */
export function limitValues(): Record<LimitName, number> {
    const values = {} as Record<LimitName, number>;
    for (const name of Object.keys(LIMITS) as LimitName[]) values[name] = LIMITS[name].value;
    return values;
}
