/**
 * The config schema (class C, docs/research/18_finding_classes/README.md, design 4; R5:L-2, R5:N-5): where a
 * field's validity is decided together with the fields it depends on, once, before anything is stored or built. Its
 * configuration (S67): every option's default, accepted values,
 * clamp, warnings and modes are declared once in CONFIG_SCHEMA, normaliseConfig() is the one reading of a start()
 * argument, and the cross-field invariants are declared once in CONFIG_INVARIANTS. host.ts keeps no validation of its
 * own: it stores what normaliseConfig() returns, says its warnings once per element and message, and refuses what it
 * refuses.
 *
 * Why. A field checked on its own can hold a value every other check accepts and the configuration as a whole cannot
 * use. A `callLimits` budget below 1 admits no call (R4:C-6), and a byte budget smaller than one call (the
 * smallest call frame measures about 136 bytes; R5:N-5) would answer every guest call, sandboxFetch() and guest writes
 * included, BUSY forever, a code that says "retry". The invariant is about two values at once, the budget and the
 * weight of a call, so it is declared here as one (CALL_INVARIANTS): a call heavier than the
 * byte budget can never fit an empty window, so it is refused with ARGS_NOT_TRANSFERABLE, which is not retryable, at both
 * ends (admitGuestCall here for the element; the bootstrap's broker applies the same rule to the same literal), and a
 * byte budget below the largest call (RPC_MAX_BYTES) says once which calls it refuses.
 *
 * test/unit/config-schema.test.ts checks every invariant over a seeded random set of configurations and the edges
 * between them, that normalising is idempotent and its warnings deterministic, that no assigned key leaks, and that
 * docs/API.md's Configuration table and this schema name the same options with the same defaults and modes.
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */
import type { CallLimits } from '../host';
import { SAFE_CAPABILITIES, UNSAFE_CAPABILITIES, type SafeCapability, type UnsafeCapability } from '../csp-directives';
import { filterCapabilities } from './capabilities';
import { NO_ORIGINS, ORIGIN_KINDS, shown, type OriginPolicy } from './csp/origin-kinds';
import { NETWORK_MODES_FLAG } from './build-flag';
import { networkModes } from './network-modes';
import { RPC_MAX_BYTES, type BudgetRefusal } from './rpc';
import { MAX_TOTAL_BYTES } from './files';
import { VIEW_RENDER_MAX_LENGTH } from './in-sandbox-view';
import { defineData, hasOwnField, ownField, type Complete, type Holds } from './utils';
import { watchdogBudget } from './watchdog';
import { fixedDetail, joinDetails, reasonText, type LibraryDetail } from './reasons';
import { mintUncodedError } from './minted-errors';
import { LINK_RULES, NO_LINKS, readLinks } from './links';

/** The per-second budget of the calls the guest makes, per environment: what both ends count. */
export interface CallBudget {
    calls: number;
    bytes: number;
}

// The defaults of `callLimits` (R3:M-2).
// 1000 calls (R4:M-6): at 4900 calls per second Firefox's host page was 32–37% busy, with gaps of 1.8 s in bursts. At
// 1000, a strict guest calling paced at the budget and one sending a second's worth at once each second leave Firefox's
// host page its idle ticks, longest gap 15–27 ms (the e2e spec of R4:M-6, in test/e2e/).
export const GUEST_CALLS_PER_SECOND = 1000;
export const GUEST_CALL_BYTES_PER_SECOND = 67108864;

export const DEFAULT_CALL_BUDGET: Readonly<CallBudget> = Object.freeze({ calls: GUEST_CALLS_PER_SECOND, bytes: GUEST_CALL_BYTES_PER_SECOND });

/**
 * The heaviest call a budget carries: what a call may weigh (its whole frame, measured as RPC_MAX_BYTES is) to fit an
 * empty window. A heavier one is refused ARGS_NOT_TRANSFERABLE, never BUSY: no wait would ever let it through.
 */
export function heaviestCall(budget: Readonly<CallBudget>): number {
    return Math.min(RPC_MAX_BYTES, budget.bytes);
}

/**
 * The cross-field invariants of `callLimits`, each stated once, over the normalised budget. The schema's test checks
 * every one of them over random and edge configurations.
 */
export const CALL_INVARIANTS: readonly { name: string; holds: (budget: Readonly<CallBudget>) => boolean }[] = [
    { name: 'each field is a finite number of at least 1', holds: (budget) => Number.isFinite(budget.calls) && budget.calls >= 1 && Number.isFinite(budget.bytes) && budget.bytes >= 1 },
    // "every call that can be carried fits an empty window": a call no heavier than the heaviest call is one call and
    // that many bytes, both within the window
    { name: 'every call that can be carried fits an empty window', holds: (budget) => budget.calls >= 1 && heaviestCall(budget) <= budget.bytes },
    { name: 'a call is carried up to RPC_MAX_BYTES or the byte budget, whichever is smaller', holds: (budget) => heaviestCall(budget) === Math.min(RPC_MAX_BYTES, budget.bytes) },
];

/** The fields of `callLimits`, as a value: what callBudgetOf reads (own fields only, ownField), and what the config tests enumerate. */
export const CALL_LIMIT_FIELDS = ['maxPerSecond', 'maxBytesPerSecond'] as const satisfies readonly (keyof CallLimits)[];
type CallLimitFieldsComplete = Holds<Complete<keyof CallLimits, typeof CALL_LIMIT_FIELDS>>;

/**
 * The call budget `callLimits` asks for (from the copy start() took). Each field is a finite number >= 1, else its
 * default: left out, silently; anything else (Infinity, a number below 1, NaN, a string), with a warning. There is no
 * "off": a budget that can be lifted is one a config typo lifts. Nor a budget that admits nothing (R4:C-6):
 * below 1, every call would be BUSY forever, without a word, since no call weighs less than 1. A byte budget below
 * RPC_MAX_BYTES is kept, with one warning: calls heavier than it are refused ARGS_NOT_TRANSFERABLE (heaviestCall). A
 * callLimits that is not an object gives the defaults. A value it cannot take goes to `invalid` (a warning by default;
 * start()'s reading refuses it there, InvalidValue), the warning about a valid small byte budget to `warn`.
 */
export function callBudgetOf(callLimits: unknown, warn: (message: string) => void, invalid: InvalidValue = warningOnly(warn)): Readonly<CallBudget> {
    if (callLimits === undefined) return DEFAULT_CALL_BUDGET;
    if (!callLimits || typeof callLimits !== 'object' || Array.isArray(callLimits)) {
        invalid(`[Sandbox] callLimits must be an object; ${shown(callLimits)} was ignored: the defaults apply (${DEFAULT_CALL_BUDGET.calls} calls and ${DEFAULT_CALL_BUDGET.bytes} bytes per second).`, `[Sandbox] start(): callLimits must be an object, not ${shown(callLimits)}.`);
        return DEFAULT_CALL_BUDGET;
    }
    const limits = callLimits as Record<string, unknown>;
    const field = (name: keyof CallLimits, fallback: number): number => {
        const value = ownField(limits, name);
        if (value === undefined) return fallback;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return value;
        const given = typeof value === 'number' ? String(value) : shown(value);
        invalid(`[Sandbox] callLimits.${name} must be a finite number >= 1; ${given} was ignored: the default ${fallback} applies.`, `[Sandbox] start(): callLimits.${name} must be a finite number >= 1, not ${given}.`);
        return fallback;
    };
    const budget = Object.freeze({ calls: field('maxPerSecond', DEFAULT_CALL_BUDGET.calls), bytes: field('maxBytesPerSecond', DEFAULT_CALL_BUDGET.bytes) });
    if (budget.bytes < RPC_MAX_BYTES) warn(`[Sandbox] callLimits.maxBytesPerSecond is ${budget.bytes}, below the largest call (${RPC_MAX_BYTES} bytes): a call heavier than ${budget.bytes} bytes is refused with ARGS_NOT_TRANSFERABLE.`);
    return budget;
}

/** An InvalidValue that only warns: the lenient reading. */
export const warningOnly = (warn: (message: string) => void): InvalidValue => (warning) => {
    if (warning !== null) warn(warning);
};

/** Why a guest call past the budget is refused (BUSY): the same words in the guest's broker (in-sandbox-script.ts). */
export const callBudgetText = (budget: Readonly<CallBudget>) => `more than ${budget.calls} calls or ${budget.bytes} bytes of calls in one second`;

/** Why a guest call heavier than the byte budget is refused (ARGS_NOT_TRANSFERABLE): the same words in the guest's broker. */
export const heavyCallText = (budget: Readonly<CallBudget>) => `the call is heavier than callLimits.maxBytesPerSecond (${budget.bytes} bytes), so it can never be carried`;

/** The windows one environment counts guest calls in (rate-limit.ts): calls, and bytes of them. */
export interface CallWindows {
    fits(time: number, weight?: number): boolean;
    admit(time: number, weight?: number): boolean;
}

/**
 * One guest call of `bytes` against the budget, at `time` (the element's end; the bootstrap's broker applies the same rule
 * before sending): null when it is admitted, and then counted against both windows; else the refusal, and nothing is
 * counted. A call heavier than the heaviest call is refused for good before the windows are asked.
 */
export function admitGuestCall(budget: Readonly<CallBudget>, calls: CallWindows, bytesWindow: CallWindows, bytes: number, time: number): BudgetRefusal | null {
    if (bytes > heaviestCall(budget)) return { code: 'ARGS_NOT_TRANSFERABLE', reason: heavyCallText(budget) };
    if (!calls.fits(time) || !bytesWindow.fits(time, bytes)) return { code: 'BUSY', reason: callBudgetText(budget) };
    calls.admit(time);
    bytesWindow.admit(time, bytes);
    return null;
}

// ---- The whole configuration (S67)

/** The execution modes. Anything else is refused: the sandbox does not start (AR:A4). */
export const SANDBOX_MODES = ['strict', 'sealed', 'cooperative', 'worker'] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];
export const isSandboxMode = (mode: unknown): mode is SandboxMode => (SANDBOX_MODES as readonly unknown[]).includes(mode);

/**
 * The modes whose guest code runs in a worker that strict mode's view spawns (ADR-005): strict, and sealed, which is
 * strict with no network (docs/research/24_sealed_mode). They share the view, its worker, the renderer and the bootstrap.
 */
export const STRICT_VIEW_MODES = ['strict', 'sealed'] as const satisfies readonly SandboxMode[];
export const hasStrictView = (mode: unknown): boolean => (STRICT_VIEW_MODES as readonly unknown[]).includes(mode);

/**
 * The modes that take the options that open the network, `origins` and `fetchBridge`: every mode but sealed. They are
 * the network modes, which a build has only with its flag on (build-flag.ts).
 */
export const NETWORK_MODES = NETWORK_MODES_FLAG.modes satisfies readonly SandboxMode[];

/** The options that open the network, which sealed mode does not have. */
export const NETWORK_OPTIONS = NETWORK_MODES_FLAG.options;

/**
 * A config refused with a reason of the library's own (TERMINATION_REASONS), not "could not be used": the element's
 * refusal is that text alone (host.ts, _configure).
 */
export class ConfigRefusal extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'ConfigRefusal';
    }
}

/**
 * In a build without the network modes (the default build: build-flag.ts), a config that asks for one of them (NETWORK_MODES)
 * or for an option that opens the network (NETWORK_OPTIONS, with any value but `undefined`) is refused whole, with a
 * reason that names the flag (`networkModesOff`): never read as sealed mode, and never stripped of the option (research
 * 24, D9; the mechanism of sealedNetworkRefusal). Decided before any option is read, so nothing of the config is applied.
 */
export function networkModesOffRefusal(mode: unknown, source: Record<string, unknown>): ConfigRefusal | null {
    if (networkModes() !== null) return null;
    const asksForMode = (NETWORK_MODES as readonly unknown[]).includes(mode);
    const asksForOption = NETWORK_OPTIONS.some(name => ownField(source, name) !== undefined);
    return asksForMode || asksForOption ? mintUncodedError(ConfigRefusal, reasonText('networkModesOff')) : null;
}

/**
 * A sealed config that names `origins` or `fetchBridge` (with any value but `undefined`) is refused whole, with its
 * reason (`sealedNetwork`), never read as another mode and never stripped: the mode written, or implied (sealed is the
 * default, so a config that names no mode is sealed; ADR-008). An option outside its modes is otherwise
 * ignored with a warning; these two would open the network the mode does not have, so silence would be the wrong failure.
 */
export function sealedNetworkRefusal(mode: unknown, source: Record<string, unknown>): ConfigRefusal | null {
    if (mode !== 'sealed') return null;
    return NETWORK_OPTIONS.some(name => ownField(source, name) !== undefined) ? mintUncodedError(ConfigRefusal, reasonText('sealedNetwork')) : null;
}

/**
 * A sealed config that turns `scriptUnsafe` on (a literal `true`, the one value that enables it) is refused whole, with
 * its reason (`sealedScriptUnsafe`), as one that names a network option is: never read as strict mode, never stripped
 * (S74, class A: INHERITED_CONTEXT.cspPolicyText; BD6:ISO-1). The option asks the platform to run strings as code, and
 * the platform checks every string against the policy list the worker inherits from the host page, which reports the
 * refusal with the page's policy text and to its endpoint; sealed mode runs no string as code (code-from-strings.ts).
 */
export function sealedScriptUnsafeRefusal(mode: unknown, source: Record<string, unknown>): ConfigRefusal | null {
    if (mode !== 'sealed') return null;
    return ownField(source, 'scriptUnsafe') === true ? mintUncodedError(ConfigRefusal, reasonText('sealedScriptUnsafe')) : null;
}

/**
 * Strict and sealed mode's `html` longer than one render may be (VIEW_RENDER_MAX_LENGTH: the initial view is a render) is
 * refused with its reason (`htmlTooLong`), by start() (normaliseConfig), before anything
 * stores or reads it (BD7:LIM-3): the view parses the whole of its initial markup before its renderer can refuse any of
 * it, so the bound is decided here, where the markup arrives. Cooperative mode's `html` is its guest document, which the
 * browser parses as it is, and worker mode's is ignored.
 */
export function htmlRefusal(mode: unknown, html: unknown): ConfigRefusal | null {
    if (!hasStrictView(mode) || typeof html !== 'string') return null;
    return html.length > VIEW_RENDER_MAX_LENGTH ? mintUncodedError(ConfigRefusal, reasonText('htmlTooLong')) : null;
}

// Old names of modes: refused like any other value that is not a mode, never an alias (nothing is published, so no
// config needs one), and the refusal names the new one: a note of the library's own for each old name, so the reason
// carries the library's text and never the configured value (BD5:DOC-2).
const RENAMED_MODES: Readonly<Record<string, LibraryDetail>> = Object.freeze({ iframe: fixedDetail(" ('iframe' was renamed 'cooperative')") });

/** " ('iframe' was renamed 'cooperative')" for an old name of a mode, else ''. */
export function renamedModeNote(mode: unknown): LibraryDetail {
    return typeof mode === 'string' && Object.hasOwn(RENAMED_MODES, mode) ? RENAMED_MODES[mode]! : fixedDetail('');
}

/** A mode as a warning shows it (a reason never does: BD5:DOC-2): a string, clamped, or its type. */
export const describeMode = (mode: unknown): string => (typeof mode === 'string' ? JSON.stringify(mode.slice(0, 32)) : `of type ${mode === null ? 'null' : typeof mode}`);

// A build without the network modes has sealed mode alone (ADR-009): what an unknown mode's refusal and warning add
// there, so that neither sends its reader to a mode the build refuses next.
const SEALED_ALONE_NOTE = fixedDetail(`; this build has sealed mode alone (${NETWORK_MODES_FLAG.env}=${NETWORK_MODES_FLAG.on} builds the others)`);

/** "; this build has sealed mode alone (…)" in a build without the network modes, else ''. */
export function buildModesNote(): LibraryDetail {
    return networkModes() === null ? SEALED_ALONE_NOTE : fixedDetail('');
}

/** Why no environment is built for a mode that is not one (the build's refusal, _buildRefusal), or null. */
export const unknownModeReason = (mode: unknown): string | null => (isSandboxMode(mode) ? null : reasonText('unknownMode', joinDetails(renamedModeNote(mode), buildModesNote())));

/** The warning for a mode that is not one: the modes there are, the build's own among them, and what start() takes. */
export function unknownModeNotice(mode: unknown): string {
    const startsWith = networkModes() === null ? "'sealed', or no mode" : 'one of them';
    return `[Sandbox] mode ${describeMode(mode)} is not one of ${SANDBOX_MODES.join(', ')}${renamedModeNote(mode)}${buildModesNote()}: the sandbox starts only with ${startsWith}.`;
}

// The sandbox flags of strict mode's view, always (why: host.ts, at its import): listing one of them in `capabilities`
// there asks for nothing more, so it is kept, not dropped.
export const STRICT_VIEW_FLAGS = ['allow-scripts', 'allow-forms'] as const;
const STRICT_CAPABILITIES = [...SAFE_CAPABILITIES, ...STRICT_VIEW_FLAGS] as const;

// The strict view's two switches: the value each takes when it is left out, and what `false` means, in words. A value
// that is a boolean is itself; anything else is false, the safe side of both (animations removed, no autoplay).
const VIEW_SWITCHES = { allowAnimations: false, allowAutoplay: false } as const;
type ViewSwitch = keyof typeof VIEW_SWITCHES;
const VIEW_SWITCH_OFF: Readonly<Record<ViewSwitch, string>> = {
    allowAnimations: 'animations and transitions are removed from the view',
    allowAutoplay: 'media in the view does not autoplay',
};

/**
 * The configuration as the element keeps it: every option, normalised, and nothing else. `origins`, `fetchBridge` and
 * `callLimits` are not kept here: each is parsed into what the build reads (NormalisedConfig). `mode` can hold a value
 * that is not a mode; every build is refused then (unknownModeReason).
 */
export interface StoredConfig {
    mode: unknown;
    scriptUnsafe: boolean;
    capabilities: SafeCapability[];
    unsafeCapabilities: UnsafeCapability[];
    html: string;
    entry?: string;
    workerExecutionTimeout: number;
    watchdogTimeout: number;
    autoResize: boolean;
    guestWrites: boolean;
    /** The URLs a click on a marked link opens (links.ts), in the embedder's order: none where the mode has no view. */
    links: readonly string[];
    allowAnimations: boolean;
    allowAutoplay: boolean;
    /** The host page's policy as the embedder gave it, `false` (the page sends none), or absent: the connect lists are dropped (host-connect.ts, hostReach). */
    hostContentSecurityPolicy?: string | false;
}

/** What start()'s options normalise to: everything a build reads of the configuration. */
export interface NormalisedConfig {
    config: StoredConfig;
    /** The validated `fetchBridge` option (fetch-bridge.ts, FetchPolicy), which only the network modes read; null when off, and in sealed mode. */
    fetchPolicy: object | null;
    origins: OriginPolicy;
    callBudget: Readonly<CallBudget>;
}

/**
 * What normalising reads besides the argument: the host page, from host-site.ts, whose rules are about it. Only the
 * rules of the options that open the network (NETWORK_OPTIONS) read it, and sealed mode runs neither of them (readIn),
 * so a sealed config asks nothing of the host page.
 */
export interface NormaliseContext {
    /**
     * The host page's origin (host-site.ts, `hostPageOrigin`: `self.origin` of the element's realm): the input of the
     * rules about that origin, the private-network rule of every `origins` kind (limitHostReach) and the rules of
     * fetchBridge.allow (fetch-bridge.ts).
     */
    hostOrigin: string;
    /**
     * The origins whose sites count as the host page's site (host-site.ts, `hostSiteOrigins`: `self.origin`, the
     * top-level document's URL's origin, every ancestor's): the one input of the same-site rule (limitHostReach).
     */
    hostSites: readonly string[];
}

/**
 * A value an option does not take. Read for start(), the argument is refused with a TypeError whose message is
 * `refusal`, and nothing is stored (design 01, "start(app, grants)": start() throws for the shape and type of each
 * option); read leniently, the warning is said (none when null) and the rule's fallback is stored.
 */
export type InvalidValue = (warning: string | null, refusal: string) => void;

/**
 * How a value an option cannot take is read: start() refuses it; the lenient reading warns and stores the option's
 * fallback, which defaultConfig() (an argument that names nothing) and the schema's tests use.
 */
export type ConfigReading = 'lenient' | 'start';

/** What an option's rules see while one argument is normalised. */
export interface OptionInput {
    /** the argument's own value for the option (undefined when it has none) */
    given: unknown;
    /** whether the argument has the option as an own key, even one whose value is undefined */
    present: boolean;
    /** the mode as stored (the argument's, or the default) */
    mode: unknown;
    /** the host page (NormaliseContext), read when a rule first asks for it, at most once per argument */
    host: () => NormaliseContext;
    warn: (message: string) => void;
    /** a value the option does not take (InvalidValue): a refusal for start(), a warning when read leniently */
    invalid: InvalidValue;
}

/**
 * The host page as normaliseConfig() takes it: its values, or a function that reads them, called only when a rule asks
 * (the network options' rules), and at most once per argument.
 */
export type HostPage = NormaliseContext | (() => NormaliseContext);

/** Whose an option is: the app's (its author wrote it) or the embedder's (what the embedder allows the app). */
export const OPTION_OWNERS = ['app', 'embedder'] as const;
export type OptionOwner = (typeof OPTION_OWNERS)[number];

/**
 * One option, declared once: its default, the modes that read it, and how a given value becomes the stored one.
 *  - `default`: what an option left out takes; `documented` is docs/API.md's Default cell for it, word for word, and
 *    `modes` its Modes cell (test/unit/config-schema.test.ts keeps the table and the schema equal).
 *  - `modes`: the modes whose build reads it. In any other mode (`ignoredIn`, the same set as a test over the mode; a
 *    test keeps them equal) it holds its default, whatever was given, and says so with `ignoredWarning` when it has
 *    one; the others are ignored silently, as docs/API.md says.
 *  - `read`: the stored value of a given one, with a warning for what it could not take. A throw refuses the config.
 *  - `notice`: what an option in use says about itself (an unsafe value enabled).
 *  - `owner`: whose the option is (I17, design 01): the app's own content, which `start()` takes in its first argument
 *    (SandboxApp), or the embedder's, which it takes in the second (SandboxGrants). Each argument refuses an option of
 *    the other. Every key of the schema has one, a removed one included (test/unit/config-schema.test.ts).
 * A removed option (`removed`) is never stored: it is ignored, with that warning, by start(), whose
 * grants take it as the embedder's key it always was.
 */
export interface OptionRule {
    readonly owner?: OptionOwner;
    readonly default?: unknown;
    readonly documented?: string;
    readonly modes?: readonly SandboxMode[];
    readonly ignoredIn?: (mode: unknown) => boolean;
    readonly ignoredWarning?: (input: OptionInput, read: unknown) => string | null;
    readonly read?: (input: OptionInput) => unknown;
    readonly notice?: (input: OptionInput, read: unknown) => readonly string[];
    readonly removed?: string;
}

const ALL_MODES = SANDBOX_MODES;
const noStrictView = (mode: unknown) => !hasStrictView(mode);
const asList = <T>(value: T[] | undefined): T[] => value ?? [];

/**
 * Only a literal true enables a switch: each one is interpolated into a bootstrap as a literal. The lenient reading takes any
 * other value as false, silently; start() refuses one that is not a boolean, unless the mode ignores the option.
 */
const literalTrue = (name: 'autoResize' | 'scriptUnsafe' | 'guestWrites') => ({ given, mode, invalid }: OptionInput): boolean => {
    if (given !== undefined && typeof given !== 'boolean' && !ignoredIn(name, mode)) invalid(null, `[Sandbox] start(): ${name} must be a boolean, not ${shown(given)}.`);
    return given === true;
};

/**
 * A delay in ms: a finite number > 0, else 0, off (watchdog.ts, watchdogBudget). Anything else than 0 or a left-out option
 * that gives off says so once (BD4:NEW-3), as a refused `callLimits` field does, unless the mode ignores the option.
 */
const delay = (name: 'watchdogTimeout' | 'workerExecutionTimeout', off: string) => ({ given, mode, invalid }: OptionInput): number => {
    const ms = watchdogBudget(given);
    if (ms === 0 && given !== undefined && given !== 0 && !ignoredIn(name, mode)) {
        const value = typeof given === 'number' ? String(given) : shown(given);
        invalid(`[Sandbox] ${name} must be a finite number > 0 (milliseconds), or 0 for off; ${value} was ignored: ${off}.`, `[Sandbox] start(): ${name} must be a finite number > 0 (milliseconds), or 0 for off, not ${value}.`);
    }
    return ms;
};

/** `links` read by its rules (links.ts): the list, or a refusal of the config that names the rule it breaks. */
const linksOf = (given: unknown): readonly string[] => {
    const read = readLinks(given);
    if ('refused' in read) throw mintUncodedError(ConfigRefusal, reasonText('linksRefused', fixedDetail(LINK_RULES[read.refused])));
    return read.links;
};

/** One of the view's switches (strict mode): its default when left out, the boolean it is, else false with a warning. */
const viewSwitch = (name: ViewSwitch) => ({ given, mode, invalid }: OptionInput): boolean => {
    if (given === undefined) return VIEW_SWITCHES[name];
    if (typeof given === 'boolean') return given;
    if (hasStrictView(mode)) invalid(`[Sandbox] ${name} must be a boolean; ${shown(given)} was taken as false: ${VIEW_SWITCH_OFF[name]}.`, `[Sandbox] start(): ${name} must be a boolean, not ${shown(given)}.`);
    return false;
};

/**
 * The schema: every option of SandboxConfig, in the order its rules run. The warnings come in that order: the values
 * read, then the notices, then what this mode ignores. docs/API.md#configuration is its reference.
 */
export const CONFIG_SCHEMA = {
    mode: {
        owner: 'embedder',
        // sealed, the mode with no network, is the default (ADR-008): a config that names no mode and names origins or
        // fetchBridge is a sealed config, so it is refused (sealedNetworkRefusal), never read as strict
        default: 'sealed', documented: "`'sealed'`", modes: ALL_MODES,
        // any other value is kept, and refused at every build (unknownModeReason), never read as the default (AR:A4)
        read: ({ given }) => (given === undefined ? 'sealed' : given),
        notice: ({ mode }) => (isSandboxMode(mode) ? [] : [unknownModeNotice(mode)]),
    },
    capabilities: {
        owner: 'embedder',
        default: [], documented: '`[]`', modes: ALL_MODES,
        // strict mode's view always has its own flags (STRICT_VIEW_FLAGS), so listing one of them there is not dropped
        read: ({ given, mode, invalid }) => asList(filterCapabilities(given, (hasStrictView(mode ?? 'sealed') ? STRICT_CAPABILITIES : SAFE_CAPABILITIES) as readonly SafeCapability[], 'capabilities', invalid)),
    },
    unsafeCapabilities: {
        owner: 'embedder',
        default: [], documented: '`[]`', modes: ['cooperative', 'worker'], ignoredIn: hasStrictView,
        read: ({ given, invalid }) => asList(filterCapabilities(given, UNSAFE_CAPABILITIES, 'unsafeCapabilities', invalid)),
        notice: (_, read) => (read as string[]).map(capability => `[Sandbox] unsafe capability "${capability}" is enabled: it lets guest content act outside the sandbox.`),
        ignoredWarning: ({ mode }, read) => ((read as string[]).length > 0 ? `[Sandbox] unsafeCapabilities are not available in ${mode as string} mode and were dropped: ${(read as string[]).join(', ')}.` : null),
    },
    html: {
        owner: 'app',
        default: '', documented: "`''`", modes: ['strict', 'sealed', 'cooperative'], ignoredIn: (mode) => mode === 'worker',
        // a string or nothing (R1:R1-3): anything else is dropped with a warning, never refuses the config; in strict and
        // sealed mode one longer than VIEW_RENDER_MAX_LENGTH refused it before any rule ran (htmlRefusal, BD7:LIM-3)
        read: ({ given, present, invalid }) => {
            if (typeof given === 'string') return given;
            if (present) invalid(`[Sandbox] "html" must be a string; ${shown(given)} was dropped.`, `[Sandbox] start(): "html" must be a string, not ${shown(given)}.`);
            return '';
        },
    },
    // Not in sealed mode, which has no network: a sealed config that names it is refused before any option is read
    // (sealedNetworkRefusal), and sealed mode never runs its rule (readIn), so the host page is not asked.
    fetchBridge: {
        owner: 'embedder',
        // its rule is the network modes' (network-config.ts, NETWORK_RULES): read only in a build that has them
        default: null, documented: 'off', modes: NETWORK_MODES, ignoredIn: (mode) => mode === 'sealed',
    },
    callLimits: {
        owner: 'embedder',
        default: DEFAULT_CALL_BUDGET, documented: `${DEFAULT_CALL_BUDGET.calls} calls and ${DEFAULT_CALL_BUDGET.bytes / 1048576} MiB per second`, modes: ALL_MODES,
        read: ({ given, warn, invalid }) => callBudgetOf(given, warn, invalid),
    },
    // the raw policy, replaced by `origins` (ADR-007): ignored, never adapted, so it fails closed (no origin)
    connectionsAllowed: { owner: 'embedder', removed: '[Sandbox] connectionsAllowed was removed; use origins. It was ignored: the guest policy admits only the exact origins listed in `origins` (see docs/API.md#origins).' },
    // configured the removed Service-Worker hub (ADR-004)
    virtualFilesUrl: { owner: 'embedder', removed: '[Sandbox] "virtualFilesUrl" is no longer supported and was ignored: give the app its files with start() and read them in the guest through sandboxFiles (see docs/ADR-004).' },
    origins: {
        owner: 'embedder',
        // Never read in sealed mode, the default (readIn), as fetchBridge; its rule is the network modes' too.
        default: NO_ORIGINS, documented: 'none', modes: NETWORK_MODES, ignoredIn: (mode) => mode === 'sealed',
    },
    hostContentSecurityPolicy: {
        owner: 'embedder',
        default: undefined, documented: 'none: `origins.connect` and `fetchBridge.allow` are dropped', modes: ALL_MODES,
        // a string (the page's policy text) or false (the page sends none); anything else is ignored with a warning, as if left out
        read: ({ given, invalid }) => {
            if (given === undefined || typeof given === 'string' || given === false) return given;
            invalid(`[Sandbox] hostContentSecurityPolicy must be a string or false; ${shown(given)} was ignored, as if it were left out.`, `[Sandbox] start(): hostContentSecurityPolicy must be a string or false, not ${shown(given)}.`);
            return undefined;
        },
    },
    autoResize: {
        owner: 'embedder',
        default: false, documented: '`false`', modes: ['strict', 'sealed', 'cooperative'], ignoredIn: (mode) => mode === 'worker',
        read: literalTrue('autoResize'),
        ignoredWarning: (_, read) => (read === true ? '[Sandbox] autoResize has no effect in worker mode: a worker has no document to measure.' : null),
    },
    entry: {
        owner: 'app',
        default: undefined, documented: 'none', modes: STRICT_VIEW_MODES, ignoredIn: noStrictView,
        // a path of the app's files or nothing: start() refuses any other value, and checks the path against the files
        // it is given; each build looks it up in its snapshot (the lenient reading drops any other value silently)
        read: ({ given, invalid }) => {
            if (typeof given === 'string') return given;
            if (given !== undefined) invalid(null, `[Sandbox] start(): "entry" must be a string, not ${shown(given)}.`);
            return undefined;
        },
        ignoredWarning: (_, read) => (read ? '[Sandbox] "entry" is used only in strict and sealed mode and was ignored.' : null),
    },
    allowAnimations: {
        owner: 'embedder',
        default: VIEW_SWITCHES.allowAnimations, documented: '`false`', modes: STRICT_VIEW_MODES, ignoredIn: noStrictView,
        read: viewSwitch('allowAnimations'),
        ignoredWarning: ({ given }) => (given !== undefined ? '[Sandbox] "allowAnimations" is used only in strict and sealed mode and was ignored.' : null),
    },
    allowAutoplay: {
        owner: 'embedder',
        default: VIEW_SWITCHES.allowAutoplay, documented: '`false`', modes: STRICT_VIEW_MODES, ignoredIn: noStrictView,
        read: viewSwitch('allowAutoplay'),
        ignoredWarning: ({ given }) => (given !== undefined ? '[Sandbox] "allowAutoplay" is used only in strict and sealed mode and was ignored.' : null),
    },
    // in sealed mode, a literal true refuses the config (sealedScriptUnsafeRefusal), so it is always false there
    scriptUnsafe: {
        owner: 'embedder',
        default: false, documented: '`false`', modes: ALL_MODES,
        read: literalTrue('scriptUnsafe'),
        // the guard rail (S4): on in most presets and every e2e spec, so it says once what it costs
        notice: (_, read) => (read === true ? ["[Sandbox] scriptUnsafe is enabled: the guest policy allows 'unsafe-eval', so guest code can run strings as code (eval, new Function) and execute() runs code in the guest. It exists for testing; leave it off for untrusted content."] : []),
    },
    // not in cooperative mode: the guest document can share the host's thread, so no timer could fire meanwhile; not in
    // sealed mode, whose deadline would be an execute() call's, and sealed mode has no execute() (BD7:DOC-3)
    workerExecutionTimeout: { owner: 'embedder', default: 0, documented: '`0` (off)', modes: ['strict', 'worker'], ignoredIn: (mode) => mode === 'cooperative' || mode === 'sealed', read: delay('workerExecutionTimeout', 'no execute() deadline applies') },
    watchdogTimeout: { owner: 'embedder', default: 0, documented: '`0` (off)', modes: ALL_MODES, read: delay('watchdogTimeout', 'no watchdog runs') },
    guestWrites: { owner: 'embedder', default: false, documented: '`false`', modes: ALL_MODES, read: literalTrue('guestWrites') },
    // the view marks a link whose href is one of them, and the user's click on it opens the listed URL (design 02, I6;
    // links.ts): a list that breaks a rule refuses the config in every mode, before anything of it is stored
    links: {
        owner: 'embedder',
        default: NO_LINKS, documented: '`[]` (no link opens)', modes: STRICT_VIEW_MODES, ignoredIn: noStrictView,
        read: ({ given }) => linksOf(given),
        ignoredWarning: ({ given }) => (given !== undefined ? '[Sandbox] "links" is used only in strict and sealed mode and was ignored: no link opens.' : null),
    },
} satisfies Record<string, OptionRule>;

export type OptionName = keyof typeof CONFIG_SCHEMA;
const RULES = CONFIG_SCHEMA as Record<OptionName, OptionRule>;
const SCHEMA_NAMES = Object.keys(CONFIG_SCHEMA) as OptionName[];
/** The options SandboxConfig has, in the schema's order (the removed ones are not options). */
export const CONFIG_OPTIONS: readonly OptionName[] = SCHEMA_NAMES.filter(name => RULES[name].removed === undefined);
/**
 * The keys of the schema an owner has, removed ones included, in the schema's order: what start()'s argument of that
 * owner may name besides its own key.
 */
export const optionsOf = (owner: OptionOwner): readonly OptionName[] => SCHEMA_NAMES.filter(name => RULES[name].owner === owner);
/** The app's keys (SandboxApp, with `files`). */
export const APP_OPTIONS = optionsOf('app');
/** The embedder's keys (SandboxGrants, with `methods`), the removed options among them. */
export const EMBEDDER_OPTIONS = optionsOf('embedder');
/** The app's options as a type, derived from the schema: what SandboxApp (host.ts) is checked against. */
export type AppOptionName = { [K in OptionName]: (typeof CONFIG_SCHEMA)[K] extends { readonly owner: 'app' } ? K : never }[OptionName];
/** The embedder's options as a type, derived from the schema. */
export type EmbedderOptionName = { [K in OptionName]: (typeof CONFIG_SCHEMA)[K] extends { readonly removed: string } ? never : (typeof CONFIG_SCHEMA)[K] extends { readonly owner: 'embedder' } ? K : never }[OptionName];

/** The options parsed into a policy or a budget of their own (NormalisedConfig), never into StoredConfig. */
export const PARSED_APART: readonly OptionName[] = ['fetchBridge', 'callLimits', 'origins'];

/**
 * The options whose rules normaliseConfig() runs for an argument of `mode`, in the schema's order: every one, except in
 * sealed mode NETWORK_OPTIONS, which hold their defaults there (no origin, no fetch bridge) without their rules running.
 * Their rules are the only ones that read the host page, so a sealed config reads none of it; a sealed config that
 * names either option was refused before (sealedNetworkRefusal). A build without the network modes has no rule for
 * them to run, in any mode (a mode that is no mode included): a config that names either was refused before
 * (networkModesOffRefusal).
 */
export const readIn = (mode: unknown): readonly OptionName[] => (mode === 'sealed' || networkModes() === null ? SEALED_READ : SCHEMA_NAMES);
const SEALED_READ: readonly OptionName[] = Object.freeze(SCHEMA_NAMES.filter(name => !(NETWORK_OPTIONS as readonly string[]).includes(name)));

/**
 * The rule that reads `option`: its own, or for an option that opens the network (NETWORK_OPTIONS) the network modes',
 * which only a build that has them runs (readIn).
 */
function readOf(option: OptionName): (input: OptionInput) => unknown {
    const own = RULES[option].read;
    if (own !== undefined) return own;
    const rules = networkModes()?.rules as Readonly<Record<string, (input: OptionInput) => unknown>> | undefined;
    const networkRule = rules?.[option];
    if (networkRule === undefined) throw mintUncodedError(Error, 'an option has no rule in this build');
    return networkRule;
}

/** Whether `option` is ignored in `mode`, where it holds its default. */
export const ignoredIn = (option: OptionName, mode: unknown): boolean => RULES[option].ignoredIn?.(mode) ?? false;

/** What normalising one argument gives: the config (null when refused), every warning in order, and the refusal. */
export interface Normalised {
    value: NormalisedConfig | null;
    warnings: string[];
    /** what refused the config, which cannot be used at all, or null */
    refusal: unknown;
}

/**
 * One argument of options (already a structured clone) normalised by the schema: every option's stored value from its
 * own rule, then the cross-field rules (CONFIG_INVARIANTS), and every warning in order. Pure: it warns into the result,
 * never to the console, and never throws. A config that cannot be used (not an object; an `origins` that is not an
 * object, or a kind of it that is not a list) is a refusal, with the warnings said up to it, and nothing of it is kept
 * (FR:F6). Reads own keys only and writes only defined data properties (AR:A7, FR:F4), so no
 * key of the argument reaches a prototype, and nothing but the schema's options reaches the stored config.
 * `reading` says how a value an option cannot take is read: start()'s refuses it, with a TypeError (InvalidValue); the
 * lenient one warns and stores the option's fallback.
 */
export function normaliseConfig(copy: unknown, hostPage: HostPage, reading: ConfigReading = 'lenient'): Normalised {
    const warnings: string[] = [];
    const warn = (message: string) => { warnings.push(message); };
    const invalid: InvalidValue = reading === 'start' ? refuseValue : warningOnly(warn);
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) return { value: null, warnings, refusal: mintUncodedError(TypeError, 'the options must be an object') };
    const source = copy as Record<string, unknown>;
    let asked: NormaliseContext | null = null;
    const host = (): NormaliseContext => (asked ??= typeof hostPage === 'function' ? hostPage() : hostPage);
    const inputOf = (name: OptionName, mode: unknown): OptionInput => {
        const present = hasOwnField(source, name);
        return { given: ownField(source, name), present, mode, host, warn, invalid };
    };
    const mode = RULES.mode.read!(inputOf('mode', undefined));
    const networkModesOff = networkModesOffRefusal(mode, source);
    if (networkModesOff !== null) return { value: null, warnings, refusal: networkModesOff };
    const sealedNetwork = sealedNetworkRefusal(mode, source);
    if (sealedNetwork !== null) return { value: null, warnings, refusal: sealedNetwork };
    const sealedScriptUnsafe = sealedScriptUnsafeRefusal(mode, source);
    if (sealedScriptUnsafe !== null) return { value: null, warnings, refusal: sealedScriptUnsafe };
    const htmlTooLong = htmlRefusal(mode, ownField(source, 'html'));
    if (htmlTooLong !== null) return { value: null, warnings, refusal: htmlTooLong };
    const values = Object.create(null) as Record<OptionName, unknown>;
    for (const name of SCHEMA_NAMES) values[name] = RULES[name].default; // what readIn(mode) leaves out holds its default
    try {
        for (const name of readIn(mode)) {
            const rule = RULES[name];
            if (rule.removed !== undefined) {
                if (hasOwnField(source, name)) warn(rule.removed);
                continue;
            }
            values[name] = name === 'mode' ? mode : readOf(name)(inputOf(name, mode));
        }
    } catch (error) {
        return { value: null, warnings, refusal: error };
    }
    for (const name of CONFIG_OPTIONS) {
        if (!ignoredIn(name, mode)) warnings.push(...(RULES[name].notice?.(inputOf(name, mode), values[name]) ?? []));
    }
    // An option outside its modes: what the build never reads holds its default, so no stored value depends on it.
    for (const name of CONFIG_OPTIONS) {
        if (!ignoredIn(name, mode)) continue;
        const said = RULES[name].ignoredWarning?.(inputOf(name, mode), values[name]);
        if (said) warn(said);
        values[name] = RULES[name].default;
    }
    const config: Record<string, unknown> = {};
    for (const name of CONFIG_OPTIONS) {
        if (PARSED_APART.includes(name) || values[name] === undefined) continue;
        const value = values[name];
        defineData(config, name, Array.isArray(value) ? [...value] : value);
    }
    return {
        value: { config: config as unknown as StoredConfig, fetchPolicy: values.fetchBridge as object | null, origins: values.origins as OriginPolicy, callBudget: values.callLimits as Readonly<CallBudget> },
        warnings,
        refusal: null,
    };
}

// start()'s reading of a value an option cannot take: the argument is refused, caught as normaliseConfig's refusal.
const refuseValue: InvalidValue = (_, refusal) => {
    throw mintUncodedError(TypeError, refusal);
};

// How much a guest write measures besides its content, at most: its path. The content is a string measured two bytes per
// character, so a write of the whole file quota measures at most twice MAX_TOTAL_BYTES.
const WRITE_OVERHEAD = 64 * 1024;
/** What the warning of a byte budget below the largest call says, as the invariants find it. */
export const BELOW_LARGEST_CALL = 'below the largest call';

/** A cross-field invariant, declared once: its name, and whether it holds for one normalised config and its warnings. */
export interface ConfigInvariant {
    name: string;
    holds: (normalised: NormalisedConfig, warnings: readonly string[]) => boolean;
}

const sameValue = (a: unknown, b: unknown): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((item, i) => Object.is(item, b[i])) : Object.is(a, b));
const isDelay = (value: unknown) => value === 0 || (typeof value === 'number' && Number.isFinite(value) && value > 0);
const plainData = (value: object, proto: object) => Object.getPrototypeOf(value) === proto && Object.keys(value).every(key => Object.getOwnPropertyDescriptor(value, key)!.writable === true);

/**
 * The cross-field invariants of the whole configuration, over the normalised result: test/unit/config-schema.test.ts
 * checks every one over seeded random configs. Where one could fail, normaliseConfig repairs it (the repair is in the
 * name); the others hold by the clamps the options declare, and the test keeps it so when a clamp changes.
 * Decided and not invariants: `watchdogTimeout` and `workerExecutionTimeout` bound different things (a loop that stops
 * answering, at any time; a loop still busy at an execute()'s deadline), so either may be shorter and each stays as given.
 */
export const CONFIG_INVARIANTS: readonly ConfigInvariant[] = [
    {
        name: 'the stored config holds only the schema\'s options, own data on plain prototypes (no assigned or inherited key)',
        holds: ({ config }) => plainData(config, Object.prototype)
            && Object.keys(config).every(key => (CONFIG_OPTIONS as readonly string[]).includes(key) && !PARSED_APART.includes(key as OptionName))
            && [config.capabilities, config.unsafeCapabilities, config.links].every(list => Array.isArray(list) && plainData(list, Array.prototype)),
    },
    {
        name: 'every stored option has its type: switches are booleans, html a string, entry a string or nothing, hostContentSecurityPolicy a string, false or nothing, delays 0 or a finite number > 0, links a list of strings',
        holds: ({ config }) => config.links.every(link => typeof link === 'string') && [config.scriptUnsafe, config.autoResize, config.guestWrites, config.allowAnimations, config.allowAutoplay].every(value => typeof value === 'boolean')
            && typeof config.html === 'string' && (config.entry === undefined || typeof config.entry === 'string')
            && isDelay(config.watchdogTimeout) && isDelay(config.workerExecutionTimeout)
            && (config.hostContentSecurityPolicy === undefined || config.hostContentSecurityPolicy === false || typeof config.hostContentSecurityPolicy === 'string'),
    },
    {
        name: 'capabilities are only those the mode allows (strict and sealed: the view flags too); unsafeCapabilities only unsafe ones',
        holds: ({ config }) => config.capabilities.every(capability => ((hasStrictView(config.mode ?? 'sealed') ? STRICT_CAPABILITIES : SAFE_CAPABILITIES) as readonly string[]).includes(capability))
            && config.unsafeCapabilities.every(capability => (UNSAFE_CAPABILITIES as readonly string[]).includes(capability)),
    },
    {
        name: 'an option outside its modes holds its default (entry, allowAnimations, allowAutoplay, links outside strict and sealed; unsafeCapabilities in strict and sealed; html and autoResize in worker; workerExecutionTimeout in cooperative and sealed)',
        holds: ({ config }) => CONFIG_OPTIONS.every(name => PARSED_APART.includes(name) || !ignoredIn(name, config.mode) || sameValue((config as unknown as Record<string, unknown>)[name], RULES[name].default)),
    },
    {
        name: 'a mode the element does not know warns, and every build refuses it',
        holds: ({ config }, warnings) => isSandboxMode(config.mode) || (unknownModeReason(config.mode) !== null && warnings.some(message => message.startsWith(`[Sandbox] mode ${describeMode(config.mode)} is not one of`))),
    },
    {
        name: 'a sealed config opens no network: no origin and no fetch bridge',
        holds: ({ config, origins, fetchPolicy }) => config.mode !== 'sealed' || (fetchPolicy === null && ORIGIN_KINDS.every(kind => origins[kind].length === 0)),
    },
    {
        name: 'a sealed config runs no string as code: scriptUnsafe is false',
        holds: ({ config }) => config.mode !== 'sealed' || config.scriptUnsafe === false,
    },
    ...CALL_INVARIANTS.map(({ name, holds }): ConfigInvariant => ({ name: `callLimits: ${name}`, holds: ({ callBudget }) => holds(callBudget) })),
    {
        name: 'callLimits: a byte budget below RPC_MAX_BYTES says once which calls it refuses',
        holds: ({ callBudget }, warnings) => warnings.filter(message => message.includes(BELOW_LARGEST_CALL)).length === (callBudget.bytes < RPC_MAX_BYTES ? 1 : 0),
    },
    {
        name: 'guestWrites × the file quota × callLimits: a write of the whole quota fits one call the budget carries, or the byte budget said which calls it refuses',
        holds: ({ config, callBudget }, warnings) => !config.guestWrites || 2 * MAX_TOTAL_BYTES + WRITE_OVERHEAD <= heaviestCall(callBudget) || warnings.some(message => message.includes(BELOW_LARGEST_CALL)),
    },
];

/** The host page where no rule reads it: sealed mode's, and every config's in a build without the network modes. */
export const NO_HOST_PAGE: NormaliseContext = Object.freeze({ hostOrigin: '', hostSites: Object.freeze([]) });

/** The stored config of an argument that names nothing: every default. */
export const defaultConfig = (): StoredConfig => normaliseConfig({}, NO_HOST_PAGE).value!.config;
