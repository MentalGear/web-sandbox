/**
 * Every value the public API hands the embedder, classified by who chose it (design 02, "One registry of guest values";
 * I10): the library, the embedder itself, or the guest. A value whose owner is the guest is attacker data, whatever the
 * library validated or clamped. Mixed values take the least trusted owner of what they can hold: `listFiles()` is the
 * guest's because a committed guest write is one of its files.
 *
 * Keyed by the declarations of each build's API report, and so complete by a test: test/unit/guest-values.test.ts
 * enumerates both reports and fails for a declaration without a row, a row the build does not export, and, in a
 * declaration whose values are handed over, a member, a method's return value or an event's detail field without its
 * own row. A declaration that hands nothing over (the embedder's configuration, the guest's own globals) says so with
 * `handed: false`. The guest's text the docs must name is a row's `text`; docs/API.md's list of it is generated from
 * here (tools/docgen/extractors/guest-values.ts), and the attacker-text paragraphs are checked against it.
 *
 * Data for tests and the docs: the element itself does not import it.
 */
import type { Build } from './build-flag';

/** Who chose a value the API hands the embedder. */
export const GUEST_VALUE_OWNERS = {
    library: "the library's: a constant, a state, a code of a closed set, a count or a text from its own tables",
    embedder: "the embedder's own: what it gave the element, given back (a method's result, a reason it passed, a file type it registered), or the library's",
    guest: "the guest's, in whole or in part: attacker data, validated and clamped by the library, never made safe by it",
} as const;
export type GuestValueOwner = keyof typeof GUEST_VALUE_OWNERS;

/** One value: who chose it, why, and, for a string of the guest's the docs name, how they name it. */
export interface GuestValue {
    readonly owner: GuestValueOwner;
    readonly why: string;
    /** For text the guest chooses: the name the attacker-text lists must use, and the phrase docs/API.md's list shows. */
    readonly text?: { readonly name: string; readonly phrase: string };
}

/** The builds whose report has the declaration: `'every'`, or only the build with the network modes. */
type Builds = { readonly builds: 'every' | Build };

/**
 * A declaration's row: one value (a constant, a function, a type of a closed set), its members one by one (an interface,
 * a class or an object type whose values are handed over), or nothing handed over at all.
 */
export type GuestValueRow =
    | (Builds & GuestValue)
    | (Builds & {
        readonly members: Readonly<Record<string, GuestValue>>;
        /** Inherited members the report does not list (an `Error`'s `message`), classified too. */
        readonly inherited?: Readonly<Record<string, GuestValue>>;
    })
    | (Builds & { readonly handed: false; readonly why: string });

const LIBRARY_CONSTANT = { owner: 'library', why: 'a constant of the library', builds: 'every' } as const;
const NETWORK_CONSTANT = { owner: 'library', why: 'a constant of the library', builds: 'network' } as const;
const LIBRARY_SET = { owner: 'library', why: 'a closed set of the library\'s strings', builds: 'every' } as const;
const NETWORK_SET = { owner: 'library', why: 'a closed set of the library\'s strings', builds: 'network' } as const;
const NOTHING = { owner: 'library', why: 'returns nothing; what it throws is the library\'s' } as const;
const CONFIGURATION = { handed: false, why: "the embedder's configuration, read by start(); never handed back", builds: 'every' } as const;
const NETWORK_CONFIGURATION = { handed: false, why: "the embedder's configuration, read by start(); never handed back", builds: 'network' } as const;

export const GUEST_VALUES = {
    // ---- constants and the library's functions
    AUTO_RESIZE_MAX_HEIGHT: LIBRARY_CONSTANT,
    AUTO_RESIZE_MAX_UPDATES_PER_SECOND: LIBRARY_CONSTANT,
    EXECUTION_TIMEOUT_GRACE_MS: LIBRARY_CONSTANT,
    FETCH_ERROR_CODES: NETWORK_CONSTANT,
    GUEST_IMAGE_TYPES: LIBRARY_CONSTANT,
    GUEST_WRITE_BYTES_PER_SECOND: LIBRARY_CONSTANT,
    GUEST_WRITES_PER_SECOND: LIBRARY_CONSTANT,
    LOAD_TIMEOUT_MS: LIBRARY_CONSTANT,
    LOG_EVENTS_PER_SECOND: LIBRARY_CONSTANT,
    LOG_MAX_ARGS: LIBRARY_CONSTANT,
    LOG_MAX_STRING: LIBRARY_CONSTANT,
    MAX_INBOUND_IN_FLIGHT: LIBRARY_CONSTANT,
    MAX_LINKS: LIBRARY_CONSTANT,
    SAFE_CAPABILITIES: LIBRARY_CONSTANT,
    UNSAFE_CAPABILITIES: NETWORK_CONSTANT,
    UNSAFE_PERMISSIONS: NETWORK_CONSTANT,
    UNSAFE_SANDBOX_FLAGS: NETWORK_CONSTANT,
    VIEW_INPUT_IN_FLIGHT: LIBRARY_CONSTANT,
    VIEW_LIVENESS_TIMEOUT_MS: LIBRARY_CONSTANT,
    VIEW_RENDER_MAX_LENGTH: LIBRARY_CONSTANT,
    VIEW_SET_STYLE_LIMITS: LIBRARY_CONSTANT,
    VIEW_STYLE_PROPERTIES: LIBRARY_CONSTANT,
    VIOLATION_EVENT_LIMIT: LIBRARY_CONSTANT,
    defineWebSandbox: { owner: 'library', why: "the element's class the library defines", builds: 'every' },
    viewScriptHash: { owner: 'library', why: "the hash of the library's own view script", builds: 'every' },

    // ---- the library's closed sets: codes, states, capabilities
    FetchErrorCode: NETWORK_SET,
    FileErrorCode: LIBRARY_SET,
    GuestImageType: LIBRARY_SET,
    RpcErrorCode: LIBRARY_SET,
    RpcLibraryCode: LIBRARY_SET,
    SafeCapability: LIBRARY_SET,
    SandboxCapability: NETWORK_SET,
    SandboxLogLevel: LIBRARY_SET,
    SandboxState: LIBRARY_SET,
    UnsafeCapability: NETWORK_SET,
    UnsafePermission: NETWORK_SET,

    // ---- what the embedder gives, and the guest's own globals: nothing handed back
    CallLimits: CONFIGURATION,
    CooperativeSandboxConfig: NETWORK_CONFIGURATION,
    FetchBridgeConfig: NETWORK_CONFIGURATION,
    FileContent: { handed: false, why: "the content of an app's file, given to start(); the library hands back copies as `Uint8Array`", builds: 'every' },
    FileEntry: { handed: false, why: "an app's file, given to start(); what comes back is FileInfo", builds: 'every' },
    NetworkSandboxOptions: NETWORK_CONFIGURATION,
    SandboxApp: { handed: false, why: "the app, given to start() once; never handed back", builds: 'every' },
    SandboxConfig: CONFIGURATION,
    SandboxConfigByMode: CONFIGURATION,
    SandboxConfigOptions: CONFIGURATION,
    SandboxFiles: { handed: false, why: "the guest's global `sandboxFiles`: what the library hands the guest, not the embedder", builds: 'every' },
    SandboxGrants: { handed: false, why: "the embedder's grants, given to start() once; never handed back", builds: 'every' },
    SandboxOrigins: NETWORK_CONFIGURATION,
    SealedSandboxConfig: CONFIGURATION,
    StrictSandboxConfig: NETWORK_CONFIGURATION,
    StrictSandboxOrigins: NETWORK_CONFIGURATION,
    WorkerSandboxConfig: NETWORK_CONFIGURATION,

    // ---- what the guest hands the embedder's code
    HostMethod: {
        owner: 'guest',
        why: "the embedder's method, called with the guest's arguments: each is the guest's data, typed unknown",
        text: { name: 'arguments of a host method', phrase: 'the arguments of a host method you grant' },
        builds: 'every',
    },

    // ---- the element
    WebSandbox: {
        builds: 'every',
        members: {
            adoptedCallback: NOTHING,
            connectedCallback: NOTHING,
            disconnectedCallback: NOTHING,
            start: NOTHING,
            reset: NOTHING,
            terminate: NOTHING,
            commitGuestWrites: NOTHING,
            addEventListener: { owner: 'library', why: "returns nothing; each event's detail is classified under WebSandboxEventMap" },
            removeEventListener: NOTHING,
            call: { owner: 'guest', why: "the guest method's return value, typed unknown", text: { name: 'call()', phrase: 'the result of `call()` and `callWithTimeout()`' } },
            callWithTimeout: { owner: 'guest', why: "the guest method's return value, typed unknown" },
            listFiles: { owner: 'guest', why: "the app's files, among them the guest's committed writes (FileInfo)" },
            listGuestWrites: { owner: 'guest', why: "the guest's pending changes (GuestWrite)" },
            started: { owner: 'library', why: 'whether start() bound an app' },
            state: { owner: 'library', why: 'the lifecycle state, a closed set' },
        },
    },
    NetworkModeMethods: { builds: 'network', members: { execute: NOTHING } },
    SandboxDevTools: {
        builds: 'every',
        members: {
            activate: NOTHING,
            deactivate: NOTHING,
            toggle: NOTHING,
        },
    },

    // ---- the events and their details
    WebSandboxEventMap: {
        builds: 'every',
        members: {
            'ready': { owner: 'library', why: 'no detail (null)' },
            'terminated': { owner: 'embedder', why: "its detail's reason (below)" },
            'terminated.reason': { owner: 'embedder', why: "a reason of the library's table, or the one the embedder passed to terminate()" },
            'sandbox-log': { owner: 'guest', why: 'its detail, a SandboxLog (the element\'s own lines ride it too)' },
            'violation': { owner: 'guest', why: "its detail, a SandboxViolation: the guest's realm's or its view's claim" },
            'fileswritten': { owner: 'guest', why: "its detail's paths (below)" },
            'fileswritten.paths': { owner: 'guest', why: 'the path the guest wrote', text: { name: 'fileswritten', phrase: "`fileswritten`'s `detail.paths`" } },
            'fileschanged': { owner: 'guest', why: "its detail's paths (below)" },
            'fileschanged.paths': { owner: 'guest', why: "the paths a commit changed, which the guest's writes named" },
        },
    },
    NetworkModeEvents: { builds: 'network', members: { fetch: { owner: 'guest', why: 'its detail, a FetchRecord of a request the guest made' } } },
    SandboxLog: {
        builds: 'every',
        members: {
            type: { owner: 'library', why: "always 'LOG'" },
            level: { owner: 'library', why: 'normalised to SandboxLogLevel' },
            source: { owner: 'library', why: 'set by the element from the port the line came on' },
            args: { owner: 'guest', why: 'what the guest logged, structured-cloned and measured, typed unknown', text: { name: 'args', phrase: "a log line's `args`" } },
        },
    },
    SandboxViolation: {
        builds: 'every',
        members: {
            directive: { owner: 'guest', why: "a well-formed directive name from the guest's report" },
            blockedURI: { owner: 'guest', why: "the guest's report, cut", text: { name: 'blockedURI', phrase: "a violation's `blockedURI`" } },
            sourceFile: { owner: 'guest', why: "the guest's report, cut", text: { name: 'sourceFile', phrase: "a violation's `sourceFile`" } },
            lineNumber: { owner: 'guest', why: "a number of the guest's report" },
            columnNumber: { owner: 'guest', why: "a number of the guest's report" },
            source: { owner: 'library', why: 'the port the report arrived on' },
        },
    },
    FetchRecord: {
        builds: 'network',
        members: {
            method: { owner: 'guest', why: "the guest's method, checked to be one (else '')" },
            url: { owner: 'guest', why: 'the URL the guest asked for, cut', text: { name: 'url', phrase: "a `fetch` record's `url` (it can be `javascript:`)" } },
            durationMs: { owner: 'library', why: 'measured by the library' },
            outcome: { owner: 'library', why: 'a closed set' },
            status: { owner: 'guest', why: 'the status of a response to a request the guest chose' },
            bytes: { owner: 'library', why: 'counted by the library' },
            code: { owner: 'library', why: 'a FetchErrorCode' },
            reason: { owner: 'library', why: "the library's text for a refusal" },
        },
    },
    FileInfo: {
        builds: 'every',
        members: {
            path: { owner: 'guest', why: "a registered path, or the path of a guest's committed write", text: { name: 'listFiles()', phrase: "a path `listFiles()` gives for a committed write" } },
            size: { owner: 'library', why: 'counted by the library' },
            type: { owner: 'embedder', why: "the type the embedder registered, or the library's for the path (FILE_TYPES)" },
        },
    },
    GuestWrite: {
        builds: 'every',
        members: {
            path: { owner: 'guest', why: 'the path the guest wrote', text: { name: 'listGuestWrites()', phrase: "the path of a guest's write (`listGuestWrites()`)" } },
            change: { owner: 'library', why: "'write' or 'remove'" },
            type: { owner: 'library', why: "FILE_TYPES's for the path (I8): never a type the guest gave, though the guest chose the path" },
            size: { owner: 'library', why: 'counted by the library' },
            content: { owner: 'guest', why: 'the bytes the guest wrote, as GuestBytes (below)' },
        },
    },
    GuestBytes: {
        builds: 'every',
        members: {
            size: { owner: 'library', why: 'counted by the library' },
            bytes: { owner: 'guest', why: 'a copy of the bytes the guest wrote' },
            text: { owner: 'guest', why: 'the bytes the guest wrote, decoded as UTF-8', text: { name: 'content.text()', phrase: "a guest write's `content.text()`" } },
            image: { owner: 'guest', why: "the bytes the guest wrote, in a Blob whose type is the library's, read from their signature (GUEST_IMAGE_TYPES), or null" },
            save: NOTHING,
        },
    },
    RpcError: {
        builds: 'every',
        members: { code: { owner: 'library', why: 'an RpcErrorCode: a code the other side claims outside the set reads as HANDLER_ERROR' } },
        inherited: { message: { owner: 'guest', why: "for UNKNOWN_METHOD, HANDLER_ERROR and RESULT_NOT_TRANSFERABLE, the guest's text", text: { name: 'message', phrase: 'the message of a call the guest rejected' } } },
    },
    FileError: {
        builds: 'every',
        members: { code: { owner: 'library', why: 'a FileErrorCode' } },
        inherited: { message: { owner: 'guest', why: "the library's text, quoting a path a guest write may have chosen" } },
    },
} as const satisfies Readonly<Record<string, GuestValueRow>>;
export type GuestValueDeclaration = keyof typeof GUEST_VALUES;

/** The declarations of `build`'s report, by their names. */
export function guestValueDeclarations(build: Build): GuestValueDeclaration[] {
    const names: GuestValueDeclaration[] = [];
    for (const [name, row] of Object.entries(GUEST_VALUES) as [GuestValueDeclaration, GuestValueRow][]) {
        if (row.builds === 'every' || row.builds === build) names.push(name);
    }
    return names;
}

/** One value of the guest's that is text the docs name: where it is, the builds that have it, and how the docs name it. */
export interface GuestText {
    readonly at: string;
    readonly builds: 'every' | Build;
    readonly name: string;
    readonly phrase: string;
}

/** Every classified value of the guest's that is text the docs name. */
export function guestText(): GuestText[] {
    const texts: GuestText[] = [];
    for (const [declaration, row] of Object.entries(GUEST_VALUES) as [string, GuestValueRow][]) {
        const add = (at: string, value: GuestValue) => {
            if (value.owner === 'guest' && value.text) texts.push({ at, builds: row.builds, ...value.text });
        };
        if ('owner' in row) add(declaration, row);
        if (!('members' in row)) continue;
        for (const [member, value] of Object.entries(row.members)) add(`${declaration}.${member}`, value);
        for (const [member, value] of Object.entries(row.inherited ?? {})) add(`${declaration}.${member}`, value);
    }
    return texts;
}
