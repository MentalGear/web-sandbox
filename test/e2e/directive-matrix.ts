/**
 * The directive matrix as values (S74, class A; test/e2e/directive-matrix.spec.ts runs it): for each Content-Security-Policy
 * directive a host page might set, the outcome of a strict-mode sandbox (with the fetch bridge) on a host page whose policy
 * has that directive at a restrictive value. A sandbox either works normally or ends with a named termination reason, never a
 * silent partial state; a degraded sandbox is only allowed with a warning the table names.
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
    /** Why, where the outcome is not what the directive's name suggests. */
    readonly note?: string;
}

const works = (bridge: 'ok' | 'refused' = 'ok', warns?: MatrixWarning): Outcome => warns ? { kind: 'works', bridge, warns } : { kind: 'works', bridge };
const ends = (reason: ReasonId): Outcome => ({ kind: 'terminates', reason });
// Firefox has no Trusted Types: the page's directive does nothing there
const NO_TRUSTED_TYPES_IN_FIREFOX = { firefox: works() } as const;

/** Directives the matrix cannot run, and why. */
export const EXCLUDED = {
    'upgrade-insecure-requests': 'the e2e server is http: the page\'s own subresources would be upgraded to a port that serves no https; the library\'s own policy upgrades insecure requests already (docs/API.md#fetchbridge)',
    'block-all-mixed-content': 'retired (CSP3 dropped it for upgrade-insecure-requests); engines ignore it',
    'navigate-to': 'retired from CSP3 (never shipped in the engines of the suite)',
    'plugin-types': 'retired (no plugins); engines ignore it',
    'referrer': 'retired (the Referrer-Policy header replaced it); engines ignore it',
    'reflected-xss': 'retired (X-XSS-Protection\'s directive); engines ignore it',
    'require-sri-for': 'retired experimental directive; engines ignore it',
} as const satisfies Partial<Record<CspDirective, string>>;

/**
 * The cases. The host's base policy is the realistic one (test/e2e/realistic-host.ts: the hash, `worker-src 'self' blob:`, the
 * style hashes, `base-uri 'self' about:`, Trusted Types with the library's policy named, `connect-src 'self'` and the host's own
 * origin), and a case replaces one directive of it. A `script-src` case keeps `'self'` (the host page's own script must run).
 */
export const DIRECTIVE_CASES = {
    'child-src': [{ value: "'none'", row: 'cspFetch', outcome: works(), note: 'a srcdoc frame loads no URL, so no frame directive refuses it' }],
    'connect-src': [
        { value: "'none'", row: 'cspFetch', outcome: works('refused'), note: "the library drops the bridge's allow list (docs/API.md#your-connect-src)" },
        { value: "'self'", row: 'cspFetch', outcome: works('refused'), note: "'self' admits nothing to the library, which drops the host page's own origin from the bridge's allow list on every engine: the engines disagree on what 'self' matches in a sandboxed frame (docs/API.md#your-connect-src)" },
    ],
    'default-src': [{ value: "'none'", row: 'cspFetch', outcome: works(), note: "the base names every directive the library needs, so the fallback decides nothing" }],
    'fenced-frame-src': [{ value: "'none'", row: 'cspFetch', outcome: works() }],
    'font-src': [{ value: "'none'", row: 'cspFetch', outcome: works() }],
    'frame-src': [{ value: "'none'", row: 'cspFetch', outcome: works(), note: 'a srcdoc frame loads no URL' }],
    'img-src': [{ value: "'none'", row: 'cspFetch', outcome: works() }],
    'manifest-src': [{ value: "'none'", row: 'cspFetch', outcome: works() }],
    'media-src': [{ value: "'none'", row: 'cspFetch', outcome: works() }],
    'object-src': [{ value: "'none'", row: 'cspFetch', outcome: works() }],
    'prefetch-src': [{ value: "'none'", row: 'cspFetch', outcome: works() }],
    'script-src': [{ value: "'self'", row: 'cspScript', outcome: ends('startupBlocked'), note: "the view bootstrap's hash is missing" }],
    'script-src-elem': [{ value: "'self'", row: 'cspScript', outcome: ends('startupBlocked'), note: "script elements are the bootstrap's kind" }],
    'script-src-attr': [{ value: "'none'", row: 'cspScript', outcome: works(), note: 'the library uses no inline event handler' }],
    'style-src': [
        { value: "'none'", row: 'cspStyle', outcome: works('ok', 'wrapperStyle'), note: 'the wrapper style is refused: the frame is 150 px high, and the element says so once' },
        { value: "'self'", row: 'cspStyle', outcome: works('ok', 'wrapperStyle'), note: 'the same' },
    ],
    'style-src-elem': [{ value: "'self'", row: 'cspStyle', outcome: works('ok', 'wrapperStyle'), note: 'the wrapper style is a style element' }],
    'style-src-attr': [{ value: "'none'", row: 'cspStyle', outcome: works(), note: 'the library styles nothing by attribute' }],
    'worker-src': [
        { value: "'none'", row: 'cspWorker', outcome: ends('workerRefused') },
        { value: "'self'", row: 'cspWorker', outcome: ends('workerRefused'), note: 'blob: is missing' },
    ],
    'base-uri': [
        { value: "'none'", row: 'cspBaseUri', outcome: ends('environmentBase') },
        { value: "'self'", row: 'cspBaseUri', outcome: ends('environmentBase'), note: 'about: is missing' },
    ],
    'sandbox': [{ value: 'allow-scripts allow-same-origin', row: 'documentOrigin', outcome: works(), note: "the host page's own sandbox flags (no allow-forms, popups, modals) are inherited by the frames" }],
    'form-action': [{ value: "'none'", row: 'uiSurfaces', outcome: works() }],
    'frame-ancestors': [{ value: "'none'", row: 'uiSurfaces', outcome: works(), note: 'binds the host page when it is framed, not the library' }],
    'report-to': [{ value: 'nowhere', row: 'trustedTypesRequirement', outcome: works() }],
    'report-uri': [{ value: '/nowhere', row: 'trustedTypesRequirement', outcome: works() }],
    'require-trusted-types-for': [{ value: "'script'", row: 'trustedTypesRequirement', outcome: works(), note: "the base already enforces it; the library's writes go through its policy" }],
    'trusted-types': [
        { value: "'none'", row: 'trustedTypesRequirement', outcome: ends('trustedTypes'), engines: NO_TRUSTED_TYPES_IN_FIREFOX },
        { value: 'other', row: 'trustedTypesRequirement', outcome: ends('trustedTypes'), engines: NO_TRUSTED_TYPES_IN_FIREFOX },
        { value: 'web-sandbox', row: 'trustedTypesDefault', outcome: works(), note: "the library's policy named alone: the host's own default policy is not created" },
    ],
} as const satisfies Record<Exclude<CspDirective, keyof typeof EXCLUDED>, readonly MatrixCase[]>;

/** Headers of the page that reach the sandbox besides the policy list. */
export const HEADER_CASES = [
    { header: 'cross-origin-embedder-policy', value: 'require-corp', row: 'coep', outcome: works(), engines: { webkit: ends('workerRefused') }, note: "WebKit refuses the view's blob: worker under require-corp" },
    { header: 'cross-origin-embedder-policy', value: 'credentialless', row: 'coep', outcome: works(), note: 'alone it does not make the page cross-origin isolated' },
    { header: 'cross-origin-opener-policy', value: 'same-origin', row: 'coep', outcome: works(), note: 'alone it does not make the page cross-origin isolated' },
    // COOP and COEP together can make the host page cross-origin isolated, which is not supported on any engine
    // (docs/API.md#host-page-policy): the element refuses to build on an isolated host page (host.ts, `_buildRefusal`), before
    // any frame exists, with `environmentIsolated`. The outcome follows the page's isolation, never the engine: the spec reads
    // `crossOriginIsolated` of the page and requires the sandbox to end exactly when it is true. Which pairs isolate the page is
    // the engine's (observed): COOP with `require-corp` everywhere; with `credentialless` in Chromium and Firefox, not in WebKit.
    { header: 'cross-origin-embedder-policy', value: 'require-corp', also: { 'cross-origin-opener-policy': 'same-origin' }, row: 'coep', outcome: ends('environmentIsolated'), note: 'with COOP same-origin: the page is cross-origin isolated on every engine' },
    { header: 'cross-origin-embedder-policy', value: 'credentialless', also: { 'cross-origin-opener-policy': 'same-origin' }, row: 'coep', outcome: ends('environmentIsolated'), engines: { webkit: works() }, note: 'with COOP same-origin: isolated in Chromium and Firefox; WebKit does not isolate a page under credentialless (observed), so the sandbox works there' },
    { header: 'referrer-policy', value: 'unsafe-url', row: 'referrer', outcome: works(), note: 'the frames carry their own no-referrer' },
    { header: 'referrer-policy', value: 'no-referrer', row: 'referrer', outcome: works() },
    { header: 'permissions-policy', value: 'fullscreen=(), clipboard-write=(), autoplay=()', row: 'permissionsPolicy', outcome: works() },
] as const satisfies readonly (MatrixCase & { header: 'cross-origin-embedder-policy' | 'cross-origin-opener-policy' | 'referrer-policy' | 'permissions-policy'; also?: { readonly 'cross-origin-opener-policy': 'same-origin' } })[];

/** The outcome of a case on an engine. */
export const outcomeOn = (matrixCase: MatrixCase, engine: MatrixEngine): Outcome => matrixCase.engines?.[engine] ?? matrixCase.outcome;

/** Every row a case of the matrix covers. */
export const matrixRows = (): Set<InheritedContextId> => new Set<InheritedContextId>([
    ...Object.values(DIRECTIVE_CASES).flatMap(cases => (cases as readonly MatrixCase[]).map(matrixCase => matrixCase.row)),
    ...HEADER_CASES.map(matrixCase => matrixCase.row),
]);
