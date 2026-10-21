/**
 * The config schema (class C, docs/research/18_finding_classes/README.md, design 4; R5:L-2, R5:N-5): where a
 * field's validity is decided together with the fields it depends on, once, before anything is stored or built. Its
 * configuration (S67): every option's default, accepted values,
 * clamp, warnings and modes are declared once in CONFIG_SCHEMA, normaliseConfig() is the one reading of a setConfig()
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
import { NO_ORIGINS, ORIGIN_KINDS, parseOrigins, shown, type OriginPolicy } from './csp/origins';
import { isPrivateHost, toFetchPolicy, type FetchPolicy } from './fetch-bridge';
import { sharesHostSite } from './origin';
import { RPC_MAX_BYTES, type BudgetRefusal } from './rpc';
import { MAX_TOTAL_BYTES } from './files';
import { defineData } from './utils';
import { watchdogBudget } from './watchdog';
import { reasonText } from './reasons';

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

/**
 * The call budget `callLimits` asks for (from the copy setConfig() took). Each field is a finite number >= 1, else its
 * default: left out, silently; anything else (Infinity, a number below 1, NaN, a string), with a warning. There is no
 * "off": a budget that can be lifted is one a config typo lifts. Nor a budget that admits nothing (R4:C-6):
 * below 1, every call would be BUSY forever, without a word, since no call weighs less than 1. A byte budget below
 * RPC_MAX_BYTES is kept, with one warning: calls heavier than it are refused ARGS_NOT_TRANSFERABLE (heaviestCall). Never
 * throws: a callLimits that is not an object is warned about and gives the defaults.
 */
export function callBudgetOf(callLimits: unknown, warn: (message: string) => void): Readonly<CallBudget> {
    if (callLimits === undefined) return DEFAULT_CALL_BUDGET;
    if (!callLimits || typeof callLimits !== 'object' || Array.isArray(callLimits)) {
        warn(`[Sandbox] callLimits must be an object; ${shown(callLimits)} was ignored: the defaults apply (${DEFAULT_CALL_BUDGET.calls} calls and ${DEFAULT_CALL_BUDGET.bytes} bytes per second).`);
        return DEFAULT_CALL_BUDGET;
    }
    const limits = callLimits as Record<string, unknown>;
    const field = (name: keyof CallLimits, fallback: number): number => {
        const value = limits[name];
        if (value === undefined) return fallback;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return value;
        warn(`[Sandbox] callLimits.${name} must be a finite number >= 1; ${typeof value === 'number' ? String(value) : shown(value)} was ignored: the default ${fallback} applies.`);
        return fallback;
    };
    const budget = Object.freeze({ calls: field('maxPerSecond', DEFAULT_CALL_BUDGET.calls), bytes: field('maxBytesPerSecond', DEFAULT_CALL_BUDGET.bytes) });
    if (budget.bytes < RPC_MAX_BYTES) warn(`[Sandbox] callLimits.maxBytesPerSecond is ${budget.bytes}, below the largest call (${RPC_MAX_BYTES} bytes): a call heavier than ${budget.bytes} bytes is refused with ARGS_NOT_TRANSFERABLE.`);
    return budget;
}

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
export const SANDBOX_MODES = ['strict', 'cooperative', 'worker'] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];
export const isSandboxMode = (mode: unknown): mode is SandboxMode => (SANDBOX_MODES as readonly unknown[]).includes(mode);

// Old names of modes: refused like any other value that is not a mode, never an alias (nothing is published, so no
// config needs one), and the refusal names the new one.
const RENAMED_MODES: Readonly<Record<string, SandboxMode>> = Object.freeze({ iframe: 'cooperative' });

/** " ('iframe' was renamed 'cooperative')" for an old name of a mode, else ''. */
export function renamedModeNote(mode: unknown): string {
    if (typeof mode !== 'string' || !Object.hasOwn(RENAMED_MODES, mode)) return '';
    return ` ('${mode}' was renamed '${RENAMED_MODES[mode]}')`;
}

/** A mode as a warning or a reason shows it: a string, clamped, or its type. */
export const describeMode = (mode: unknown): string => (typeof mode === 'string' ? JSON.stringify(mode.slice(0, 32)) : `of type ${mode === null ? 'null' : typeof mode}`);

/** Why no environment is built for a mode that is not one (the build's refusal, _buildRefusal), or null. */
export const unknownModeReason = (mode: unknown): string | null => (isSandboxMode(mode) ? null : reasonText('unknownMode', `${describeMode(mode)}${renamedModeNote(mode)}`));

// The sandbox flags of strict mode's view, always (why: host.ts, at its import): listing one of them in `capabilities`
// there asks for nothing more, so it is kept, not dropped.
export const STRICT_VIEW_FLAGS = ['allow-scripts', 'allow-forms'] as const;
const STRICT_CAPABILITIES = [...SAFE_CAPABILITIES, ...STRICT_VIEW_FLAGS] as const;

// The strict view's two switches: the value each takes when it is left out, and what `false` means, in words. A value
// that is a boolean is itself; anything else is false, the safe side of both (animations removed, no autoplay).
const VIEW_SWITCHES = { allowAnimations: true, allowAutoplay: false } as const;
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
    allowAnimations: boolean;
    allowAutoplay: boolean;
}

/** What one setConfig() argument normalises to: everything a build reads of the configuration. */
export interface NormalisedConfig {
    config: StoredConfig;
    fetchPolicy: FetchPolicy | null;
    origins: OriginPolicy;
    callBudget: Readonly<CallBudget>;
}

/** What normalising reads besides the argument. */
export interface NormaliseContext {
    /** The host page's origin, which fetchBridge.allow (fetch-bridge.ts) and every `origins` kind (warnHostReach) warn about. */
    hostOrigin: string;
}

/** What an option's rules see while one argument is normalised. */
export interface OptionInput {
    /** the argument's own value for the option (undefined when it has none) */
    given: unknown;
    /** whether the argument has the option as an own key, even one whose value is undefined */
    present: boolean;
    /** the mode as stored (the argument's, or the default) */
    mode: unknown;
    context: NormaliseContext;
    warn: (message: string) => void;
}

/**
 * One option, declared once: its default, the modes that read it, and how a given value becomes the stored one.
 *  - `default`: what an option left out takes; `documented` is docs/API.md's Default cell for it, word for word, and
 *    `modes` its Modes cell (test/unit/config-schema.test.ts keeps the table and the schema equal).
 *  - `modes`: the modes whose build reads it. In any other mode (`ignoredIn`, the same set as a test over the mode; a
 *    test keeps them equal) it holds its default, whatever was given, and says so with `ignoredWarning` when it has
 *    one; the others are ignored silently, as docs/API.md says.
 *  - `read`: the stored value of a given one, with a warning for what it could not take. A throw refuses the config.
 *  - `notice`: what an option in use says about itself (an unsafe value enabled).
 * A removed option (`removed`) is never stored: it is ignored, with that warning.
 */
export interface OptionRule {
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
const notStrict = (mode: unknown) => mode !== 'strict';
const asList = <T>(value: T[] | undefined): T[] => value ?? [];

/** Only a literal true enables a switch: each one is interpolated into a bootstrap as a literal. */
const literalTrue = ({ given }: OptionInput) => given === true;

/** A delay in ms: a finite number > 0, else 0, off (watchdog.ts, watchdogBudget). */
const delay = ({ given }: OptionInput) => watchdogBudget(given);

/** One of the view's switches (strict mode): its default when left out, the boolean it is, else false with a warning. */
const viewSwitch = (name: ViewSwitch) => ({ given, mode, warn }: OptionInput): boolean => {
    if (given === undefined) return VIEW_SWITCHES[name];
    if (typeof given === 'boolean') return given;
    if (mode === 'strict') warn(`[Sandbox] ${name} must be a boolean; ${shown(given)} was taken as false: ${VIEW_SWITCH_OFF[name]}.`);
    return false;
};

/**
 * The one pass over a parsed `origins` that says what a listed origin reaches beyond the internet at large, in every
 * mode and for every kind (ORIGIN_KINDS, so a new kind is covered): one warning per kind. An origin on the host page's
 * site (sharesHostSite) may receive the host site's cookies with a guest request on Firefox and WebKit (README,
 * "Cookies"); a loopback, private or link-local host (isPrivateHost) is a machine or network of the user's, which the
 * guest then reaches. fetchBridge.allow says the same for its entries (toFetchPolicy); the fetch bridge sends no
 * credentials, so it is what the warning points to. Returns `policy` as it is.
 */
export function warnHostReach(policy: OriginPolicy, hostOrigin: string, warn: (message: string) => void): OriginPolicy {
    for (const kind of ORIGIN_KINDS) {
        const site: string[] = [];
        const local: string[] = [];
        for (const origin of policy[kind]) {
            if (sharesHostSite(origin, hostOrigin)) site.push(origin === hostOrigin ? `${origin} (the host page's own origin)` : `${origin} (on the host page's site)`);
            if (isPrivateHost(new URL(origin).hostname)) local.push(`${origin} (a loopback, private or link-local host)`);
        }
        if (site.length + local.length === 0) continue;
        const why = [
            site.length > 0 ? "a guest request to the host page's site can carry the host site's cookies (its SameSite=None cookies, on Firefox and WebKit)" : '',
            local.length > 0 ? "a loopback, private or link-local host is the user's own machine or network, which the guest then reaches" : '',
        ].filter(Boolean).join('; ');
        warn(`[Sandbox] origins.${kind} lists ${[...site, ...local].join(', ')}: ${why}. Prefer the fetch bridge (fetchBridge.allow), whose requests carry no credentials.`);
    }
    return policy;
}

/**
 * The schema: every option of SandboxConfig, in the order its rules run. The warnings come in that order: the values
 * read, then the notices, then what this mode ignores. docs/API.md#configuration is its reference.
 */
export const CONFIG_SCHEMA = {
    mode: {
        default: 'strict', documented: "`'strict'`", modes: ALL_MODES,
        // any other value is kept, and refused at every build (unknownModeReason), never read as the default (AR:A4)
        read: ({ given }) => (given === undefined ? 'strict' : given),
        notice: ({ mode }) => (isSandboxMode(mode) ? [] : [`[Sandbox] mode ${describeMode(mode)} is not one of ${SANDBOX_MODES.join(', ')}${renamedModeNote(mode)}: the sandbox will not start until setConfig() names one of them.`]),
    },
    capabilities: {
        default: [], documented: '`[]`', modes: ALL_MODES,
        // strict mode's view always has its own flags (STRICT_VIEW_FLAGS), so listing one of them there is not dropped
        read: ({ given, mode, warn }) => asList(filterCapabilities(given, ((mode ?? 'strict') === 'strict' ? STRICT_CAPABILITIES : SAFE_CAPABILITIES) as readonly SafeCapability[], 'capabilities', warn)),
    },
    unsafeCapabilities: {
        default: [], documented: '`[]`', modes: ['cooperative', 'worker'], ignoredIn: (mode) => mode === 'strict',
        read: ({ given, warn }) => asList(filterCapabilities(given, UNSAFE_CAPABILITIES, 'unsafeCapabilities', warn)),
        notice: (_, read) => (read as string[]).map(capability => `[Sandbox] unsafe capability "${capability}" is enabled: it lets guest content act outside the sandbox.`),
        ignoredWarning: (_, read) => ((read as string[]).length > 0 ? `[Sandbox] unsafeCapabilities are not available in strict mode and were dropped: ${(read as string[]).join(', ')}.` : null),
    },
    html: {
        default: '', documented: "`''`", modes: ['strict', 'cooperative'], ignoredIn: (mode) => mode === 'worker',
        // a string or nothing (R1:R1-3): anything else is dropped with a warning, never refuses the config
        read: ({ given, present, warn }) => {
            if (typeof given === 'string') return given;
            if (present) warn(`[Sandbox] "html" must be a string; ${shown(given)} was dropped.`);
            return '';
        },
    },
    fetchBridge: {
        default: null, documented: 'off', modes: ALL_MODES,
        read: ({ given, warn, context }) => toFetchPolicy(given, warn, context.hostOrigin),
    },
    callLimits: {
        default: DEFAULT_CALL_BUDGET, documented: `${DEFAULT_CALL_BUDGET.calls} calls and ${DEFAULT_CALL_BUDGET.bytes / 1048576} MiB per second`, modes: ALL_MODES,
        read: ({ given, warn }) => callBudgetOf(given, warn),
    },
    // the raw policy, replaced by `origins` (ADR-007): ignored, never adapted, so it fails closed (no origin)
    connectionsAllowed: { removed: '[Sandbox] connectionsAllowed was removed; use origins. It was ignored: the guest policy admits only the exact origins listed in `origins` (see docs/API.md#origins).' },
    // configured the removed Service-Worker hub (ADR-004)
    virtualFilesUrl: { removed: '[Sandbox] "virtualFilesUrl" is no longer supported and was ignored: register files with registerFiles() and read them in the guest through sandboxFiles (see docs/ADR-004).' },
    origins: {
        default: NO_ORIGINS, documented: 'none', modes: ALL_MODES,
        // parsed for the mode the build will have, the default included, so strict mode drops `scripts` whether the
        // config names it or not; a value that cannot be read refuses the config (origins.ts)
        read: ({ given, mode, warn, context }) => warnHostReach(parseOrigins(given, mode, warn), context.hostOrigin, warn),
    },
    autoResize: {
        default: false, documented: '`false`', modes: ['strict', 'cooperative'], ignoredIn: (mode) => mode === 'worker',
        read: literalTrue,
        ignoredWarning: (_, read) => (read === true ? '[Sandbox] autoResize has no effect in worker mode: a worker has no document to measure.' : null),
    },
    entry: {
        default: undefined, documented: 'none', modes: ['strict'], ignoredIn: notStrict,
        // a registered path or nothing: it is looked up in each build's snapshot
        read: ({ given }) => (typeof given === 'string' ? given : undefined),
        ignoredWarning: (_, read) => (read ? '[Sandbox] "entry" is used only in strict mode and was ignored.' : null),
    },
    allowAnimations: {
        default: VIEW_SWITCHES.allowAnimations, documented: '`true`', modes: ['strict'], ignoredIn: notStrict,
        read: viewSwitch('allowAnimations'),
        ignoredWarning: ({ given }) => (given !== undefined ? '[Sandbox] "allowAnimations" is used only in strict mode and was ignored.' : null),
    },
    allowAutoplay: {
        default: VIEW_SWITCHES.allowAutoplay, documented: '`false`', modes: ['strict'], ignoredIn: notStrict,
        read: viewSwitch('allowAutoplay'),
        ignoredWarning: ({ given }) => (given !== undefined ? '[Sandbox] "allowAutoplay" is used only in strict mode and was ignored.' : null),
    },
    scriptUnsafe: {
        default: false, documented: '`false`', modes: ALL_MODES,
        read: literalTrue,
        // the guard rail (S4): on in most presets and every e2e spec, so it says once what it costs
        notice: (_, read) => (read === true ? ["[Sandbox] scriptUnsafe is enabled: the guest policy allows 'unsafe-eval', so guest code can run strings as code (eval, new Function) and execute() runs code in the guest. It exists for testing; leave it off for untrusted content."] : []),
    },
    // not in cooperative mode: the guest document can share the host's thread, so no timer could fire meanwhile
    workerExecutionTimeout: { default: 0, documented: '`0` (off)', modes: ['worker', 'strict'], ignoredIn: (mode) => mode === 'cooperative', read: delay },
    watchdogTimeout: { default: 0, documented: '`0` (off)', modes: ALL_MODES, read: delay },
    guestWrites: { default: false, documented: '`false`', modes: ALL_MODES, read: literalTrue },
} satisfies Record<string, OptionRule>;

export type OptionName = keyof typeof CONFIG_SCHEMA;
const RULES = CONFIG_SCHEMA as Record<OptionName, OptionRule>;
const SCHEMA_NAMES = Object.keys(CONFIG_SCHEMA) as OptionName[];
/** The options SandboxConfig has, in the schema's order (the removed ones are not options). */
export const CONFIG_OPTIONS: readonly OptionName[] = SCHEMA_NAMES.filter(name => RULES[name].removed === undefined);
/** The options parsed into a policy or a budget of their own (NormalisedConfig), never into StoredConfig. */
export const PARSED_APART: readonly OptionName[] = ['fetchBridge', 'callLimits', 'origins'];

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
 * One setConfig() argument (already a structured clone) normalised by the schema: every option's stored value from its
 * own rule, then the cross-field rules (CONFIG_INVARIANTS), and every warning in order. Pure: it warns into the result,
 * never to the console, and never throws. A config that cannot be used (not an object; an `origins` that is not an
 * object, or a kind of it that is not a list) is a refusal, with the warnings said up to it, and nothing of it is kept
 * (FR:F6). Reads own keys only and writes only defined data properties (AR:A7, FR:F4), so no
 * key of the argument reaches a prototype, and nothing but the schema's options reaches the stored config.
 */
export function normaliseConfig(copy: unknown, context: NormaliseContext): Normalised {
    const warnings: string[] = [];
    const warn = (message: string) => { warnings.push(message); };
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) return { value: null, warnings, refusal: new TypeError('setConfig() takes an object') };
    const source = copy as Record<string, unknown>;
    const inputOf = (name: OptionName, mode: unknown): OptionInput => {
        const present = Object.hasOwn(source, name);
        return { given: present ? source[name] : undefined, present, mode, context, warn };
    };
    const mode = RULES.mode.read!(inputOf('mode', undefined));
    const values = Object.create(null) as Record<OptionName, unknown>;
    try {
        for (const name of SCHEMA_NAMES) {
            const rule = RULES[name];
            if (rule.removed !== undefined) {
                if (Object.hasOwn(source, name)) warn(rule.removed);
                continue;
            }
            values[name] = name === 'mode' ? mode : rule.read!(inputOf(name, mode));
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
        value: { config: config as unknown as StoredConfig, fetchPolicy: values.fetchBridge as FetchPolicy | null, origins: values.origins as OriginPolicy, callBudget: values.callLimits as Readonly<CallBudget> },
        warnings,
        refusal: null,
    };
}

// How much a call measures besides the bytes it carries, at most, for the two calls whose payload an option bounds: a
// sandboxFetch() request (its URL, at most MAX_URL characters measured two bytes each, and its method and a few header
// names) and a sandboxFetch() result (the URL, the status text and the response's headers, which the browser bounds:
// Chromium at 256 KiB, measured twice that). A guest write carries its path and its content, a string measured two bytes
// per character, so a write of the whole file quota measures at most twice MAX_TOTAL_BYTES.
const FETCH_REQUEST_OVERHEAD = 64 * 1024;
const FETCH_RESULT_OVERHEAD = 1024 * 1024;
const WRITE_OVERHEAD = 64 * 1024;
const BELOW_LARGEST_CALL = 'below the largest call';

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
            && [config.capabilities, config.unsafeCapabilities].every(list => Array.isArray(list) && plainData(list, Array.prototype)),
    },
    {
        name: 'every stored option has its type: switches are booleans, html a string, entry a string or nothing, delays 0 or a finite number > 0',
        holds: ({ config }) => [config.scriptUnsafe, config.autoResize, config.guestWrites, config.allowAnimations, config.allowAutoplay].every(value => typeof value === 'boolean')
            && typeof config.html === 'string' && (config.entry === undefined || typeof config.entry === 'string')
            && isDelay(config.watchdogTimeout) && isDelay(config.workerExecutionTimeout),
    },
    {
        name: 'capabilities are only those the mode allows (strict: its view flags too); unsafeCapabilities only unsafe ones',
        holds: ({ config }) => config.capabilities.every(capability => (((config.mode ?? 'strict') === 'strict' ? STRICT_CAPABILITIES : SAFE_CAPABILITIES) as readonly string[]).includes(capability))
            && config.unsafeCapabilities.every(capability => (UNSAFE_CAPABILITIES as readonly string[]).includes(capability)),
    },
    {
        name: 'an option outside its modes holds its default (entry, allowAnimations, allowAutoplay outside strict; unsafeCapabilities in strict; html and autoResize in worker; workerExecutionTimeout in cooperative)',
        holds: ({ config }) => CONFIG_OPTIONS.every(name => PARSED_APART.includes(name) || !ignoredIn(name, config.mode) || sameValue((config as unknown as Record<string, unknown>)[name], RULES[name].default)),
    },
    {
        name: 'a mode the element does not know warns, and every build refuses it',
        holds: ({ config }, warnings) => isSandboxMode(config.mode) || (unknownModeReason(config.mode) !== null && warnings.some(message => message.startsWith(`[Sandbox] mode ${describeMode(config.mode)} is not one of`))),
    },
    ...CALL_INVARIANTS.map(({ name, holds }): ConfigInvariant => ({ name: `callLimits: ${name}`, holds: ({ callBudget }) => holds(callBudget) })),
    {
        name: 'callLimits: a byte budget below RPC_MAX_BYTES says once which calls it refuses',
        holds: ({ callBudget }, warnings) => warnings.filter(message => message.includes(BELOW_LARGEST_CALL)).length === (callBudget.bytes < RPC_MAX_BYTES ? 1 : 0),
    },
    {
        name: 'fetchBridge: every budget admits a request (maxBytes, timeoutMs, maxConcurrent are whole numbers >= 1)',
        holds: ({ fetchPolicy }) => fetchPolicy === null || [fetchPolicy.maxBytes, fetchPolicy.timeoutMs, fetchPolicy.maxConcurrent].every(value => Number.isInteger(value) && value >= 1),
    },
    {
        name: 'fetchBridge: a response of maxBytes fits one call result (RPC_MAX_BYTES), so a response the bridge admits is never refused as a result',
        holds: ({ fetchPolicy }) => fetchPolicy === null || fetchPolicy.maxBytes + FETCH_RESULT_OVERHEAD <= RPC_MAX_BYTES,
    },
    {
        name: 'fetchBridge × callLimits: a request body of maxBytes (bytes) fits one call the budget carries, or the byte budget said which calls it refuses',
        holds: ({ fetchPolicy, callBudget }, warnings) => fetchPolicy === null || fetchPolicy.maxBytes + FETCH_REQUEST_OVERHEAD <= heaviestCall(callBudget) || warnings.some(message => message.includes(BELOW_LARGEST_CALL)),
    },
    {
        name: 'guestWrites × the file quota × callLimits: a write of the whole quota fits one call the budget carries, or the byte budget said which calls it refuses',
        holds: ({ config, callBudget }, warnings) => !config.guestWrites || 2 * MAX_TOTAL_BYTES + WRITE_OVERHEAD <= heaviestCall(callBudget) || warnings.some(message => message.includes(BELOW_LARGEST_CALL)),
    },
];

/** The stored config of an argument that names nothing: every default. */
export const defaultConfig = (): StoredConfig => normaliseConfig({}, { hostOrigin: '' }).value!.config;
