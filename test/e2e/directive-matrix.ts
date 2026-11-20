/**
 * The directive matrix as values (S74, class A; test/e2e/directive-matrix.spec.ts runs it): for each Content-Security-Policy
 * directive a host page might set, the outcome of a strict-mode sandbox (with the fetch bridge) and of a sealed one on a host
 * page whose policy has that directive at a restrictive value. A sandbox either works normally or ends with a named
 * termination reason, never a silent partial state; a degraded sandbox is only allowed with a warning the table names.
 * Sealed mode's view is the served file (design 03), a document the host page's policy does not reach: there the page's
 * policy decides only whether the element may frame the file (`frame-src`, and its fallbacks), so a case names sealed
 * mode's outcome where it is not strict mode's (`sealed`).
 *
 * Values first: `CSP_DIRECTIVES` is the closed list; every directive is either in `EXCLUDED` (with why the matrix cannot
 * run it) or has cases in `DIRECTIVE_CASES`, and the types fail until a new directive is classified. A case names the
 * INHERITED_CONTEXT row it covers and the outcome on every engine, with the engines that differ named.
 * test/unit/realistic-host-coverage.test.ts keeps the table complete (the directives the docs and the inventory name are all
 * in the list) and makes every row of the inventory covered by this table or by the realistic-host spec.
 *
 * Plain data and types: imported by a unit test as well as by the spec, so it imports nothing at run time.
 */
import type { InheritedContextId } from '@src/lib/inherited-context';
import type { ReasonId } from '@src/lib/reasons';

/** Every directive of CSP Level 3's fetch, document, navigation and reporting groups, Trusted Types' two, and the retired ones a host page still sends. */
export const CSP_DIRECTIVES = [
    // fetch directives
    'child-src', 'connect-src', 'default-src', 'fenced-frame-src', 'font-src', 'frame-src', 'img-src', 'manifest-src', 'media-src',
    'object-src', 'prefetch-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem', 'style-src-attr', 'worker-src',
    // document directives
    'base-uri', 'sandbox',
    // navigation directives
    'form-action', 'frame-ancestors',
    // reporting directives
    'report-to', 'report-uri',
    // Trusted Types
    'require-trusted-types-for', 'trusted-types',
    // other
    'upgrade-insecure-requests',
    // retired, still sent by pages
    'block-all-mixed-content', 'navigate-to', 'plugin-types', 'referrer', 'reflected-xss', 'require-sri-for',
] as const;
export type CspDirective = (typeof CSP_DIRECTIVES)[number];

export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type MatrixEngine = (typeof ENGINES)[number];

/** The named warnings a degraded sandbox gives; the spec maps each key to the text the element logs. */
export const MATRIX_WARNINGS = ['wrapperStyle'] as const;
export type MatrixWarning = (typeof MATRIX_WARNINGS)[number];

/**
 * What a strict-mode sandbox with the fetch bridge does on that host page:
 *  - `works`: `ready` and it stays ready, the entry ran and the view rendered, the guest's own request to the host's API is not
 *    sent, `terminate()` ends it; the bridge's request to the host's origin is `ok` or `refused` (by the host's policy; the
 *    guest sees an error code), and `warns` names the warning a degraded sandbox gives (never a silent degradation);
 *  - `terminates`: the last lifecycle event is `terminated` with that reason (a `ready` may precede it), nothing of the guest
 *    ran, and no frame is left.
 */
export type Outcome =
    | { readonly kind: 'works'; readonly bridge: 'ok' | 'refused'; readonly warns?: MatrixWarning }
    | { readonly kind: 'terminates'; readonly reason: ReasonId };

export interface MatrixCase {
    /** The directive's sources, replacing the host's own (empty: the directive without a value). */
    readonly value: string;
    /** The INHERITED_CONTEXT row the case covers. */
    readonly row: InheritedContextId;
    /** The outcome on the engines that do not differ. */
    readonly outcome: Outcome;
    /** The engines whose outcome differs, with it. */
    readonly engines?: Partial<Record<MatrixEngine, Outcome>>;
    /** Sealed mode's outcome where it is not strict mode's, on every engine but those of `sealedEngines`. */
    readonly sealed?: Outcome;
    /** The engines whose sealed outcome differs from `sealed` (or from the case's outcome), with it. */
    readonly sealedEngines?: Partial<Record<MatrixEngine, Outcome>>;
    /** Why, where the outcome is not what the directive's name suggests. */
    readonly note?: string;
    /**
     * Sealed mode's outcome with the case's directive on the served file's response, enforced and report-only, where it
     * is not the policy check's finding of the header's kind (FILE_SEEN): a directive the check does not see, or one that
     * stops the view before it runs.
     */
    readonly onFile?: { readonly enforce?: Outcome; readonly report?: Outcome; readonly why?: string };
}

const works = (bridge: 'ok' | 'refused' = 'ok', warns?: MatrixWarning): Outcome => warns ? { kind: 'works', bridge, warns } : { kind: 'works', bridge };
const ends = (reason: ReasonId): Outcome => ({ kind: 'terminates', reason });

/** Directives the matrix cannot run, and why. */
export const EXCLUDED = {
    'upgrade-insecure-requests': 'the e2e server is http: the page\'s own subresources would be upgraded to a port that serves no https; the library\'s own policies carry none (docs/API.md#origins), and a host page that sends one is the embedder\'s choice',
    'block-all-mixed-content': 'retired (CSP3 dropped it for upgrade-insecure-requests); engines ignore it',
    'navigate-to': 'retired from CSP3 (never shipped in the engines of the suite)',
    'plugin-types': 'retired (no plugins); engines ignore it',
    'referrer': 'retired (the Referrer-Policy header replaced it); engines ignore it',
    'reflected-xss': 'retired (X-XSS-Protection\'s directive); engines ignore it',
    'require-sri-for': 'retired experimental directive; engines ignore it',
} as const satisfies Partial<Record<CspDirective, string>>;

/**
 * The cases. The host's base policy is the realistic one (test/e2e/realistic-host.ts: the hash, `worker-src 'self' blob:`, the
 * style hashes, `base-uri 'self' about:`, `frame-src 'self'` for the served file, Trusted Types with the library's policy
 * named, `connect-src 'self'` and the host's own origin), and a case replaces one directive of it. A `script-src` case keeps
 * `'self'` (the host page's own script must run).
 */
// Sealed mode's outcome where the host page's directive governs a document the served view does not inherit from it
const SERVED = works();
// Sealed mode's outcome where the directive refuses the element's frame of the served file
const UNFRAMED = ends('documentSilent');
/** The INHERITED_CONTEXT row the cases on the served file's response cover. */
export const FILE_ROW: InheritedContextId = 'fileHeaders';
/** Sealed mode's outcome with a directive on the file's response that the policy check sees: its finding, by the kind. */
export const FILE_SEEN = { enforce: ends('viewCsp'), report: ends('viewCspReportOnly') } as const;
// A directive on the file's response that refuses nothing the view does: a working sandbox, under either kind
const FILE_WORKS = { enforce: works(), report: works() } as const;
// One that refuses the file's guard and the view's bootstrap when enforced: no view runs
const FILE_UNRUN = { enforce: UNFRAMED, why: "enforced, it refuses the file's guard and the view's bootstrap: no view runs; report-only, the check sees it" } as const;
export const DIRECTIVE_CASES = {
    'child-src': [{ value: "'none'", row: 'cspFetch', outcome: works(), note: 'a srcdoc frame loads no URL, so no frame directive refuses it' }],
    'connect-src': [
        { value: "'none'", row: 'cspFetch', outcome: works('refused'), note: "the library drops the bridge's allow list (docs/API.md#your-connect-src)" },
        { value: "'self'", row: 'cspFetch', outcome: works('refused'), note: "'self' admits nothing to the library, which drops the host page's own origin from the bridge's allow list on every engine: the engines disagree on what 'self' matches in a sandboxed frame (docs/API.md#your-connect-src)" },
    ],
    'default-src': [{ value: "'none'", row: 'cspFetch', outcome: works(), note: "the base names every directive the library needs, so the fallback decides nothing", onFile: FILE_UNRUN }],
    'fenced-frame-src': [{ value: "'none'", row: 'cspFetch', outcome: works(), onFile: FILE_WORKS }],
    'font-src': [{ value: "'none'", row: 'cspFetch', outcome: works() }],
    'frame-src': [{ value: "'none'", row: 'cspFetch', outcome: works(), sealed: UNFRAMED, note: "a srcdoc frame loads no URL; sealed mode's frame loads the served file, which the directive refuses: the view never announces itself" }],
    'img-src': [{ value: "'none'", row: 'cspFetch', outcome: works() }],
    'manifest-src': [{ value: "'none'", row: 'cspFetch', outcome: works(), onFile: { ...FILE_WORKS, why: 'no engine fetches a manifest a framed document links' } }],
    'media-src': [{ value: "'none'", row: 'cspFetch', outcome: works() }],
    'object-src': [{ value: "'none'", row: 'cspFetch', outcome: works(), onFile: { ...FILE_WORKS, why: "the check makes no object, which is loaded only while it is rendered (POLICY_CANARIES); the renderer removes every object and embed of the guest's" } }],
    'prefetch-src': [{ value: "'none'", row: 'cspFetch', outcome: works(), onFile: { ...FILE_WORKS, why: 'no engine of the suite applies it' } }],
    'script-src': [{ value: "'self'", row: 'cspScript', outcome: ends('startupBlocked'), sealed: SERVED, note: "the view bootstrap's hash is missing; sealed mode's view runs under the file's policy", onFile: FILE_UNRUN }],
    'script-src-elem': [{ value: "'self'", row: 'cspScript', outcome: ends('startupBlocked'), sealed: SERVED, note: "script elements are the bootstrap's kind", onFile: FILE_UNRUN }],
    'script-src-attr': [{ value: "'none'", row: 'cspScript', outcome: works(), note: 'the library uses no inline event handler', onFile: { ...FILE_WORKS, why: "the view compiles no handler, and the renderer keeps none of the guest's (POLICY_CANARIES, `unseen`)" } }],
    'style-src': [
        { value: "'none'", row: 'cspStyle', outcome: works('ok', 'wrapperStyle'), sealed: SERVED, note: "the wrapper style is refused: the frame is 150 px high, and the element says so once; sealed mode's file sizes the view under its own policy" },
        { value: "'self'", row: 'cspStyle', outcome: works('ok', 'wrapperStyle'), sealed: SERVED, note: 'the same' },
    ],
    'style-src-elem': [{ value: "'self'", row: 'cspStyle', outcome: works('ok', 'wrapperStyle'), sealed: SERVED, note: 'the wrapper style is a style element' }],
    'style-src-attr': [{ value: "'none'", row: 'cspStyle', outcome: works(), note: 'the library styles nothing by attribute', onFile: { ...FILE_WORKS, why: 'the view applies styles through the CSSOM, which no style-src-attr checks' } }],
    'worker-src': [
        { value: "'none'", row: 'cspWorker', outcome: ends('workerRefused'), sealed: SERVED },
        { value: "'self'", row: 'cspWorker', outcome: ends('workerRefused'), sealed: SERVED, note: 'blob: is missing' },
    ],
    'base-uri': [
        { value: "'none'", row: 'cspBaseUri', outcome: ends('environmentBase'), sealed: SERVED, note: "sealed mode's file sets its base under its own policy", onFile: { enforce: ends('environmentBase'), why: "enforced, it refuses the file's own <base>, which comes before the <meta>: the view's base URL is not about:blank" } },
        { value: "'self'", row: 'cspBaseUri', outcome: ends('environmentBase'), sealed: SERVED, note: 'about: is missing', onFile: { enforce: ends('environmentBase'), why: "enforced, it refuses the file's own <base>" } },
    ],
    'sandbox': [{ value: 'allow-scripts allow-same-origin', row: 'documentOrigin', outcome: works(), note: "the host page's own sandbox flags (no allow-forms, popups, modals) are inherited by the frames", onFile: { ...FILE_WORKS, why: 'the file is framed sandboxed already, and a report-only sandbox is ignored' } }],
    'form-action': [{ value: "'none'", row: 'uiSurfaces', outcome: works(), onFile: { ...FILE_WORKS, why: 'the check submits no form (POLICY_CANARIES); the renderer drops every form target and the view cancels every submit' } }],
    'frame-ancestors': [{ value: "'none'", row: 'uiSurfaces', outcome: works(), note: 'binds the host page when it is framed, not the library', onFile: { enforce: UNFRAMED, report: works(), why: 'enforced, it refuses the framing of the file; report-only, nothing is refused' } }],
    'report-to': [{ value: 'nowhere', row: 'trustedTypesRequirement', outcome: works(), onFile: FILE_WORKS }],
    'report-uri': [{ value: '/nowhere', row: 'trustedTypesRequirement', outcome: works(), onFile: FILE_WORKS }],
    'require-trusted-types-for': [{ value: "'script'", row: 'trustedTypesRequirement', outcome: works(), note: "the base already enforces it; the library's writes go through its policy" }],
    'trusted-types': [
        { value: "'none'", row: 'trustedTypesRequirement', outcome: ends('trustedTypes'), sealed: SERVED, note: "every engine has Trusted Types and applies the page's directive; a browser without them would take it from hostContentSecurityPolicy (test/e2e/trusted-types-uniform.spec.ts); the element writes no HTML for sealed mode's view, whose document has no requirement of the page's" },
        { value: 'other', row: 'trustedTypesRequirement', outcome: ends('trustedTypes'), sealed: SERVED },
        { value: 'web-sandbox', row: 'trustedTypesDefault', outcome: works(), note: "the library's policy named alone: the host's own default policy is not created", onFile: { ...FILE_WORKS, why: "the view's own Trusted Types policy is the one named; a list that does not name it refuses that policy, which the check sees" } },
    ],
} as const satisfies Record<Exclude<CspDirective, keyof typeof EXCLUDED>, readonly MatrixCase[]>;

/** Headers of the page that reach the sandbox besides the policy list. */
export const HEADER_CASES = [
    // ledger: coep-require-corp
    { header: 'cross-origin-embedder-policy', value: 'require-corp', row: 'coep', outcome: works(), sealedEngines: { firefox: UNFRAMED, webkit: UNFRAMED }, note: "strict mode runs on every engine: the view's blob: worker is not refused. Sealed mode's frame loads the served file, which an embedder policy refuses unless the file's response opts in: Chromium frames it all the same, as the frame is credentialless; Firefox and WebKit refuse it, so the view never announces itself" },
    { header: 'cross-origin-embedder-policy', value: 'credentialless', row: 'coep', outcome: works(), sealedEngines: { firefox: UNFRAMED }, note: "alone it does not make the page cross-origin isolated; Firefox refuses sealed mode's frame of the served file, as under require-corp" },
    { header: 'cross-origin-opener-policy', value: 'same-origin', row: 'coep', outcome: works(), note: 'alone it does not make the page cross-origin isolated' },
    // COOP and COEP together can make the host page cross-origin isolated, which is not supported on any engine
    // (docs/API.md#host-page-policy): the element refuses to build on an isolated host page (host.ts, `_buildRefusal`), before
    // any frame exists, with `environmentIsolated`. The outcome follows the page's isolation, never the engine: the spec reads
    // `crossOriginIsolated` of the page and requires the sandbox to end exactly when it is true. Which pairs isolate the page is
    // the engine's (observed): COOP with `require-corp` everywhere; with `credentialless` in Chromium and Firefox, not in WebKit.
    { header: 'cross-origin-embedder-policy', value: 'require-corp', also: { 'cross-origin-opener-policy': 'same-origin' }, row: 'coep', outcome: ends('environmentIsolated'), note: 'with COOP same-origin: the page is cross-origin isolated on every engine' },
    // ledger: coop-coep-isolation
    { header: 'cross-origin-embedder-policy', value: 'credentialless', also: { 'cross-origin-opener-policy': 'same-origin' }, row: 'coep', outcome: ends('environmentIsolated'), engines: { webkit: works() }, note: 'with COOP same-origin: isolated in Chromium and Firefox; WebKit does not isolate a page under credentialless (observed), so the sandbox works there' },
    { header: 'referrer-policy', value: 'unsafe-url', row: 'referrer', outcome: works(), note: 'the frames carry their own no-referrer' },
    { header: 'referrer-policy', value: 'no-referrer', row: 'referrer', outcome: works() },
    { header: 'permissions-policy', value: 'fullscreen=(), clipboard-write=(), autoplay=()', row: 'permissionsPolicy', outcome: works() },
] as const satisfies readonly (MatrixCase & { header: 'cross-origin-embedder-policy' | 'cross-origin-opener-policy' | 'referrer-policy' | 'permissions-policy'; also?: { readonly 'cross-origin-opener-policy': 'same-origin' } })[];

/** The outcome of a case on an engine, in strict mode or in sealed mode. */
export function outcomeOn(matrixCase: MatrixCase, engine: MatrixEngine, mode: 'strict' | 'sealed' = 'strict'): Outcome {
    const strict = matrixCase.engines?.[engine] ?? matrixCase.outcome;
    if (mode === 'strict') return strict;
    return matrixCase.sealedEngines?.[engine] ?? matrixCase.sealed ?? strict;
}

/** Sealed mode's outcome with the case's directive on the served file's response, of `disposition`. */
export function fileOutcomeOn(matrixCase: MatrixCase, disposition: 'enforce' | 'report'): Outcome {
    return matrixCase.onFile?.[disposition] ?? FILE_SEEN[disposition];
}

/** Every row a case of the matrix covers: each directive case runs on the served file's response too (FILE_ROW). */
export const matrixRows = (): Set<InheritedContextId> => new Set<InheritedContextId>([
    FILE_ROW,
    ...Object.values(DIRECTIVE_CASES).flatMap(cases => (cases as readonly MatrixCase[]).map(matrixCase => matrixCase.row)),
    ...HEADER_CASES.map(matrixCase => matrixCase.row),
]);
