/**
 * The host page's context, as data (S74, class A): every piece of it that a document of the sandbox can inherit, and for
 * each one how the library neutralises it or that it documents it. A sandbox document is a `srcdoc` frame, so it starts
 * with a copy of its parent's policy container (CSP list, Trusted Types requirement, embedder policy, referrer policy),
 * the base URL, the cookie jar's site, the Service Worker's scope and the browser's shared UI surfaces; the library's
 * host code runs in the host page's realm. A finding that the sandbox "inherited X" is a missing row of this table, so
 * the fix adds the row (CONTRIBUTING.md, "Fixing a finding").
 *
 * Values first: this table is the one list. `test/unit/inherited-context.test.ts` fails on a row that names no test
 * file that exists, and a row of the environment check (environment-check.ts) that no row points to. docs/THREAT-MODEL.md
 * renders it (the generated region `inherited-context`, tools/docgen/extractors/inherited-context.ts).
 *
 * Internal: not exported from the package.
 */
import { COOKIE_ENGINE_FACTS, COOKIE_ENGINES } from './cookie-facts';
import type { EnvironmentCheckId } from './environment-check';

/** The engines the e2e suite runs on. */
export const CONTEXT_ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type ContextEngine = (typeof CONTEXT_ENGINES)[number];

/**
 * How a row's channel is neutralised; a row can have several.
 *  - `check`: the bootstrap's environment check refuses a document that does not read as built (environment-check.ts);
 *  - `construct`: the library's own construction leaves nothing to inherit or nothing to use;
 *  - `credentialless`: the wrapper iframe carries the `credentialless` attribute;
 *  - `refuse`: the configuration drops it, with a warning (strict mode);
 *  - `warn`: the configuration or the build warns;
 *  - `reason`: the build ends with a termination reason that names the host page's policy;
 *  - `documented`: a residual, stated with its bound in docs/THREAT-MODEL.md.
 */
export const NEUTRALISATIONS = ['check', 'construct', 'credentialless', 'refuse', 'warn', 'reason', 'documented'] as const;
export type Neutralisation = (typeof NEUTRALISATIONS)[number];

export interface InheritedContextRow {
    /** What is inherited (the host page's state and the channel it reaches the sandbox by). */
    readonly channel: string;
    /** The documents and realms that inherit it, by mode. */
    readonly inheritedBy: string;
    /** What the library does about it, or why it only documents it. */
    readonly how: string;
    /** How it is neutralised (see {@link NEUTRALISATIONS}). */
    readonly by: readonly Neutralisation[];
    /** The engines where it matters; a channel every engine passes on lists all three. */
    readonly engines: readonly ContextEngine[];
    /** The rows of the environment check (environment-check.ts) that cover it. */
    readonly environmentChecks?: readonly EnvironmentCheckId[];
    /** Test files (repository-relative) that keep it closed: a unit test or an e2e spec. */
    readonly tests: readonly string[];
}

const ALL = CONTEXT_ENGINES;

// the engines whose cookie facts say they honour the wrapper's `credentialless` attribute (cookie-facts.ts)
const CREDENTIALLESS_ENGINES = COOKIE_ENGINES.filter(engine => COOKIE_ENGINE_FACTS[engine].credentialless).map(engine => COOKIE_ENGINE_FACTS[engine].name).join(', ');

export const INHERITED_CONTEXT = {
    cspScript: {
        channel: "The host page's CSP `script-src` (`script-src-elem`): a copy is the srcdoc frames' policy, and narrows the library's",
        inheritedBy: 'every mode: the wrapper, the view, the bridge frame and the guest document',
        how: "The embedder allows the bootstrap's hash (`viewScriptHash()`), or `'unsafe-inline'` for cooperative and worker mode; a startup script the policy refuses ends the build with the reason that names the host page's policy",
        by: ['reason', 'documented'],
        engines: ALL,
        tests: ['test/e2e/host-policy.spec.ts', 'test/unit/host-page-policy.test.ts'],
    },
    cspWorker: {
        channel: "The host page's CSP `worker-src` (and `script-src`, `child-src`, `default-src` as its fallbacks)",
        inheritedBy: "strict and worker mode: the guest's `blob:` worker",
        how: 'A worker the policy refuses ends the build with the worker reason, never "the guest entry failed to start"',
        by: ['reason', 'documented'],
        engines: ALL,
        tests: ['test/e2e/host-policy.spec.ts'],
    },
    cspStyle: {
        channel: "The host page's CSP `style-src` (and its fallbacks)",
        inheritedBy: "every mode: the wrapper's style and the strict view's animation stylesheet",
        how: 'The wrapper style and the animation stylesheet have documented hashes; a policy that refuses them leaves the frame 150 px high (or drops the guest stylesheets) and the element warns once, naming the hash',
        by: ['warn', 'documented'],
        engines: ALL,
        tests: ['test/e2e/host-policy.spec.ts', 'test/unit/host-page-policy.test.ts'],
    },
    cspBaseUri: {
        channel: "The host page's CSP `base-uri`, and with it the document's base URL (a refused `<base>` leaves the host page's URL)",
        inheritedBy: 'every mode: the wrapper, and the frames nested in it',
        how: "Every bootstrap's first statement reads `document.baseURI` and stays inert unless it is `about:blank`; the element ends the sandbox with the row's reason (environment-check.ts). The bridge frame's policy carries `base-uri about:`",
        by: ['check', 'reason'],
        engines: ALL,
        environmentChecks: ['base'],
        tests: ['test/e2e/environment-check.spec.ts', 'test/unit/environment-check.test.ts', 'test/unit/environment-gate.test.ts'],
    },
    cspFetch: {
        channel: "The host page's CSP fetch directives (`img-src`, `connect-src`, `font-src`, `media-src`, `default-src`, `frame-src`): a copy narrows `origins`, in some engines and not in others (connect-facts.ts)",
        inheritedBy: 'every mode',
        how: "`connect-src` (else `default-src`) is neutralised by the library, uniformly: every origin of `origins.connect` and `fetchBridge.allow` that a policy of the page refuses is dropped, with a warning, before the guest's and the bridge's policies are written, on every engine; a `wss://` entry is kept only beside its `https://` twin. The guest's `fetch()`, `XMLHttpRequest` and `WebSocket` then admit exactly the sources of the guest policy's `connect-src` (the bootstrap's request gate, S74), refuse anything else before the browser sees it, the same way on every engine, and report it as a `violation` of the library's own, so a refusal is reported on an engine that raises no report in a worker (WebKit); the browser's policy stays underneath, and a redirect it refuses is reported per engine. No policy of the library carries `upgrade-insecure-requests` (the engines disagree on what it does to the http: form of a listed https: origin, and one sent it in cleartext), so every engine refuses that form; a host page that sends the directive itself is inherited and is the embedder's choice. The page's policy is the embedder's (`hostContentSecurityPolicy`) or is read once per page by one deliberate violation that reaches neither the network nor the DNS (host-csp.ts); a policy the parser does not understand admits nothing. The other fetch directives narrow in the browser, where the engine applies the inherited list, and are documented under `origins` and in the host-page policy section; a policy list only narrows (CSP3 intersects the lists), so the sandbox's own policy is never weakened",
        by: ['refuse', 'documented'],
        engines: ALL,
        tests: ['test/unit/host-connect.test.ts', 'test/unit/host-csp.test.ts', 'test/unit/connect-facts.test.ts', 'test/e2e/connect-uniform.spec.ts', 'test/e2e/no-plaintext.spec.ts', 'test/unit/host-page-policy.test.ts', 'test/unit/policy-guarantees.test.ts', 'test/unit/request-gate.test.ts', 'test/e2e/request-gate.spec.ts'],
    },
    trustedTypesRequirement: {
        channel: "The host page's `require-trusted-types-for 'script'` and its `trusted-types` names",
        inheritedBy: 'every mode; in cooperative mode the guest inherits the requirement',
        how: "The library writes every document and worker source through its own policy `web-sandbox` from the first write, never a string to a sink; a `trusted-types` list that does not name it ends the build with a reason that says so, and `execute()`'s string is not evaluated. A browser without Trusted Types (Firefox, at the version measured) cannot do either itself, so the library reads `require-trusted-types-for 'script'` and the `trusted-types` names from the policy text the embedder passes (`hostContentSecurityPolicy`) and refuses alike (host-trusted-types.ts); the read of the page's policy cannot supply them, because such a browser leaves out of the text it reports the directives it does not implement, so without the option nothing is applied there",
        by: ['construct', 'reason', 'refuse'],
        engines: ALL,
        tests: ['test/e2e/host-policy.spec.ts', 'test/e2e/trusted-types-uniform.spec.ts', 'test/e2e/directive-matrix.spec.ts', 'test/unit/host-trusted-types.test.ts'],
    },
    trustedTypesDefault: {
        channel: "The host page's Trusted Types default policy (host code that runs inside a library sink)",
        inheritedBy: 'the host realm: the library host code that writes a frame or a worker',
        how: "The library never writes a string to a sink where Trusted Types exist, so the default policy is never asked; a `trusted-types 'default'` the build cannot work around ends it with the Trusted Types reason (a browser without Trusted Types, from `hostContentSecurityPolicy`, as for the requirement)",
        by: ['construct', 'reason'],
        engines: ALL,
        tests: ['test/e2e/host-policy.spec.ts', 'test/e2e/trusted-types-uniform.spec.ts'],
    },
    coep: {
        channel: "The host page's Cross-Origin-Embedder-Policy and cross-origin isolation (`require-corp`, `credentialless`; COOP)",
        inheritedBy: 'every frame; the strict worker is a `blob:` worker',
        how: 'A guest never runs cross-origin isolated: the element refuses to build on a host page that reads `crossOriginIsolated === true`, before any frame exists, and a bootstrap that reads it stays inert as well (defence in depth); either way the sandbox ends with the isolation reason, on every engine (an isolated host page, COOP and COEP together, is not supported; environment-check.ts). COEP alone does not isolate the page and is documented: WebKit refuses the view\'s `blob:` worker under `require-corp`, so a strict build there ends with the worker reason; Chromium and Firefox build',
        by: ['check', 'reason', 'documented'],
        engines: ['chromium', 'firefox', 'webkit'],
        environmentChecks: ['isolated'],
        tests: ['test/e2e/host-policy.spec.ts', 'test/e2e/realistic-host.spec.ts', 'test/e2e/directive-matrix.spec.ts', 'test/unit/environment-check.test.ts', 'test/unit/environment-gate.test.ts'],
    },
    referrer: {
        channel: "The host page's URL as a referrer, and the engines' own referrer exceptions for same-site targets",
        inheritedBy: 'every mode: requests of the frames, the worker and rendered markup',
        how: "The frames are `no-referrer`, the wrapper carries a `no-referrer` meta and `<base href=\"about:blank\">`, and the strict renderer forces `referrerpolicy=\"no-referrer\"`; cooperative mode's residuals (a guest asking for `unsafe-url`) are documented",
        by: ['construct', 'documented'],
        engines: ALL,
        tests: ['test/e2e/host-url.spec.ts'],
    },
    ancestorOrigins: {
        channel: '`location.ancestorOrigins`: the host origin, shown to a document nested in the host page',
        inheritedBy: 'cooperative mode (strict mode has no guest document)',
        how: 'Documented as a cooperative limit; the host origin is not a secret',
        by: ['documented'],
        engines: ['chromium', 'webkit'],
        tests: ['test/e2e/host-url.spec.ts'],
    },
    documentOrigin: {
        channel: "The document's origin, URL and storage: the library's own text, which the host page's `script-src` admits, runs wherever it is copied",
        inheritedBy: 'every bootstrap that runs in a sandbox document (view, bridge frame, cooperative guest, worker mode\'s frame)',
        how: "Every bootstrap's first statement reads `self.origin` (`'null'`) and `location.href` (`about:srcdoc`) and stays inert on any other document: a sandbox frame without `allow-same-origin` has no host storage, cookies or DOM, and a copy in the host page does nothing",
        by: ['check', 'construct'],
        engines: ALL,
        environmentChecks: ['origin', 'url'],
        tests: ['test/e2e/environment-check.spec.ts', 'test/unit/environment-check.test.ts', 'test/unit/environment-gate.test.ts', 'test/e2e/security.spec.ts'],
    },
    cookies: {
        channel: "The host site's cookies: a request of a sandbox document is made for the host page's site, so a cookie the browser attaches by site (SameSite=None; on some engines Lax and Strict) rides on it",
        inheritedBy: "every mode: the guest's own requests to a listed origin: a WebSocket handshake and the loads of its markup and CSS (`fetch` and `XMLHttpRequest` carry none); the fetch bridge sends none",
        how: `The guest's \`fetch()\` and \`XMLHttpRequest\` never send credentials, on any engine: the bootstrap's request gate makes every fetch with \`credentials: 'omit'\` and keeps \`withCredentials\` false (in-sandbox-script.ts, S74). A WebSocket handshake and a load of an element or of CSS cannot be stripped. The wrapper iframe is \`credentialless\` in every mode: where the engine honours it (${CREDENTIALLESS_ENGINES}) it, and everything nested in it, has an empty cookie jar, so no request of the sandbox carries a cookie (its popups open without an opener). Elsewhere those requests would carry it, so an \`origins\` entry on the host page's site is dropped in every mode, with a warning (once per kind), where the site is decided from the page's origin as the element's realm has it (\`self.origin\`), with no probe, by a rule that never misses an origin the browser counts as on the site (host-site.ts: the page's host, or a host that shares its last two labels; an address, \`localhost\` or a single label only itself; a page whose origin is opaque has no site, and keeps its entries with a warning); to another site they carry that site's own cookies where the engine sends them (documented: a listed \`wss://\` server must check \`Origin\`). The fetch bridge (\`credentials: 'omit'\`) is the way to reach an API that knows the user. What each engine sends: cookie-facts.ts`,
        by: ['construct', 'credentialless', 'refuse', 'warn', 'documented'],
        engines: ALL,
        tests: ['test/e2e/cookies.spec.ts', 'test/e2e/request-gate.spec.ts', 'test/e2e/host-site.spec.ts', 'test/unit/cookie-facts.test.ts', 'test/unit/request-gate.test.ts', 'test/unit/host-site.test.ts', 'test/unit/host.test.ts', 'test/unit/config-schema.test.ts', 'test/unit/host-origin-wiring.test.ts', 'test/e2e/fetch-bridge.spec.ts'],
    },
    serviceWorker: {
        channel: "The host page's Service Worker (a cache-first one answers from the app's cache)",
        inheritedBy: 'every frame and worker; the fetch bridge, which the library makes from the host page',
        how: "A sandboxed frame has an opaque origin, which no Service Worker controls; the fetch bridge runs in a frame of its own, so the host page's Service Worker and `fetch` wrappers never apply to it",
        by: ['construct'],
        engines: ALL,
        tests: ['test/e2e/fetch-bridge-isolation.spec.ts', 'test/e2e/security.spec.ts'],
    },
    hostRealmGlobals: {
        channel: "The host realm's globals and prototypes that the library's host code uses (`fetch`, `console`, built-ins)",
        inheritedBy: "the library's host code (host.ts, the bridge's transport)",
        how: "The fetch bridge's requests are made by its own frame, not by the host page's `fetch`; host code reads guest data through captured intrinsics and never calls a function the guest could have replaced",
        by: ['construct'],
        engines: ALL,
        tests: ['test/e2e/fetch-bridge-isolation.spec.ts', 'test/unit/bootstrap-capture-and-measure.test.ts', 'test/unit/guest-realm-hardening.test.ts'],
    },
    permissionsPolicy: {
        channel: "The host page's Permissions-Policy and the frame's `allow` attribute",
        inheritedBy: 'every mode: the wrapper and the guest frame',
        how: 'The `allow` attributes come from a closed list of capabilities the embedder names; nothing else is delegated, and a host Permissions-Policy only narrows',
        by: ['construct'],
        engines: ALL,
        tests: ['test/e2e/capability-presets.spec.ts', 'test/unit/host.test.ts'],
    },
    uiSurfaces: {
        channel: "The browser's shared UI surfaces: focus, the clipboard, history, top-level navigation, the host window as a `postMessage` target",
        inheritedBy: 'cooperative and worker mode (strict mode has no guest document)',
        how: 'No `allow-top-navigation*` flag; the guest cannot move the host page through history or name its frame. Focus, the clipboard after a user\'s click and messages to the host window are documented cooperative limits (S36, S44)',
        by: ['construct', 'documented'],
        engines: ALL,
        tests: ['test/e2e/guest-realm-hardening.spec.ts', 'test/e2e/strict.spec.ts'],
    },
    eventDispatch: {
        channel: 'Events the browser dispatches synchronously into the host page when a frame is removed (focus, blur, pagehide)',
        inheritedBy: "the host page's listeners, during the element's teardown",
        how: "The teardown detaches the old environment before it releases anything, so a listener that calls `reset()` or `terminate()` re-enters a consistent element",
        by: ['construct'],
        engines: ALL,
        tests: ['test/e2e/teardown-reentry.spec.ts', 'test/unit/teardown-reentry.test.ts'],
    },
    thread: {
        channel: "The host page's thread and process: the strict view and the cooperative frame can share them",
        inheritedBy: 'strict mode on Firefox, WebKit, Android and the headless shell; cooperative mode on WebKit and in some Chromium environments',
        how: 'Documented: availability is a stated bound (the view\'s budgets, the repeated-overrun rule), and `terminate()` or removing the element gives the host page back',
        by: ['documented'],
        engines: ALL,
        tests: ['test/e2e/view-bound.spec.ts', 'test/unit/view-bound.test.ts'],
    },
} as const satisfies Record<string, InheritedContextRow>;

export type InheritedContextId = keyof typeof INHERITED_CONTEXT;

/** The rows in table order, with their ids. */
export const inheritedContextRows = (): Array<InheritedContextRow & { readonly id: InheritedContextId }> =>
    (Object.keys(INHERITED_CONTEXT) as InheritedContextId[]).map(id => ({ id, ...(INHERITED_CONTEXT[id] as InheritedContextRow) }));
