/**
 * The host page's context, as data (S74, class A): every piece of it that a document of the sandbox can inherit, and for
 * each one how the library neutralises it or that it documents it. A sandbox document is a `srcdoc` frame, so it starts
 * with a copy of its parent's policy container (CSP list, Trusted Types requirement, embedder policy, referrer policy),
 * the base URL, the cookie jar's site, the Service Worker's scope and the browser's shared UI surfaces; an engine may
 * answer a realm of the sandbox from its per-origin records of the host page (permission grants, BD5:ISO-1); the
 * library's host code runs in the host page's realm. A finding that the sandbox "inherited X" is a missing row of this table, so
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

/**
 * What a row is in sealed mode, strict mode with no network (docs/research/24_sealed_mode): its sandbox documents are
 * strict mode's, so it still inherits the row (`remains`), inherits less of it (`reduced`), or the row cannot apply
 * (`not-applicable`) because sealed mode makes no request (`no-network`) or has no guest document (`no-guest-document`).
 */
export type SealedStanding =
    | { readonly standing: 'remains'; readonly note?: string }
    | { readonly standing: 'reduced'; readonly note: string }
    | { readonly standing: 'not-applicable'; readonly because: 'no-network' | 'no-guest-document'; readonly note: string };

/**
 * What of a row remains in sealed mode, stated with its bound, and the tests that pin it. A `remains` cell of SEALED_REACH
 * (sealed-reach.ts) names one of its row's residuals, so whatever a sealed guest still reaches of the host page's context
 * is one of these.
 */
export interface Residual {
    readonly what: string;
    readonly tests: readonly string[];
}

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
    /** What it is in sealed mode (see {@link SealedStanding}); every row says. */
    readonly sealed: SealedStanding;
    /** What remains of it in sealed mode, by id (see {@link Residual}). */
    readonly residuals?: Readonly<Record<string, Residual>>;
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
        tests: ['test/e2e/host-policy.spec.ts', 'test/unit/host-page-policy.test.ts', 'test/e2e/directive-matrix.spec.ts'],
        sealed: { standing: 'remains', note: "the view's bootstrap, by its hash" },
    },
    cspWorker: {
        channel: "The host page's CSP `worker-src` (and `script-src`, `child-src`, `default-src` as its fallbacks)",
        inheritedBy: "strict and worker mode: the guest's `blob:` worker",
        how: 'A worker the policy refuses ends the build with the worker reason, never "the guest entry failed to start"',
        by: ['reason', 'documented'],
        engines: ALL,
        tests: ['test/e2e/host-policy.spec.ts', 'test/e2e/directive-matrix.spec.ts'],
        sealed: { standing: 'remains' },
    },
    cspStyle: {
        channel: "The host page's CSP `style-src` (and its fallbacks)",
        inheritedBy: "every mode: the wrapper's style and the strict view's animation stylesheet; cooperative mode's guest styles",
        how: "The wrapper style and the animation stylesheet have documented hashes; a policy that refuses them leaves the frame 150 px high (or drops the guest stylesheets) and the element warns once, naming the hash. Strict and sealed mode's view applies the guest's styles through the CSSOM, which no `style-src` checks (the `cspReporting` row), so the page needs nothing in `style-src` for them; cooperative mode's guest document holds its styles as written, and the page's `style-src` checks them (documented)",
        by: ['construct', 'warn', 'documented'],
        engines: ALL,
        tests: ['test/e2e/host-policy.spec.ts', 'test/unit/host-page-policy.test.ts', 'test/e2e/directive-matrix.spec.ts', 'test/e2e/sealed-host-policy.spec.ts', 'test/unit/inline-styles.test.ts', 'test/e2e/sealed-reach.spec.ts'],
        sealed: { standing: 'remains' },
    },
    cspBaseUri: {
        channel: "The host page's CSP `base-uri`, and with it the document's base URL (a refused `<base>` leaves the host page's URL)",
        inheritedBy: 'every mode: the wrapper, and the frames nested in it',
        how: "Every bootstrap's first statement reads `document.baseURI` and stays inert unless it is `about:blank`; the element ends the sandbox with the row's reason (environment-check.ts). The bridge frame's policy carries `base-uri about:`",
        by: ['check', 'reason'],
        engines: ALL,
        environmentChecks: ['base'],
        tests: ['test/e2e/environment-check.spec.ts', 'test/unit/environment-check.test.ts', 'test/unit/environment-gate.test.ts', 'test/e2e/directive-matrix.spec.ts'],
        sealed: { standing: 'remains', note: "defence in depth: the view's policy admits no network source, so a wrong base can load nothing" },
    },
    cspFetch: {
        channel: "The host page's CSP fetch directives (`img-src`, `connect-src`, `font-src`, `media-src`, `default-src`, `frame-src`): a copy narrows `origins`, in some engines and not in others (connect-facts.ts)",
        inheritedBy: 'every mode',
        how: "`connect-src` (else `default-src`) is neutralised by the library, uniformly, from the page's policy as the embedder gives it (`hostContentSecurityPolicy`) and from nothing else: every origin of `origins.connect` and `fetchBridge.allow` that the given policy refuses is dropped, with a warning, before the guest's and the bridge's policies are written, on every engine; without the option both lists are dropped, with one warning that says what to pass, so the library never guesses the page's policy (host-connect.ts, hostReach); `false` says the page sends none, and keeps the lists, and a policy the page does send is then applied by the browser alone, per engine (connect-facts.ts); a `wss://` entry is kept only beside its `https://` twin. The guest's `fetch()`, `XMLHttpRequest` and `WebSocket` then admit exactly the sources of the guest policy's `connect-src` (the bootstrap's request gate, S74), refuse anything else before the browser sees it, the same way on every engine, and report it as a `violation` of the library's own, so a refusal is reported on an engine that raises no report in a worker (WebKit); the browser's policy stays underneath, and a redirect it refuses is reported per engine. No policy of the library carries `upgrade-insecure-requests` (the engines disagree on what it does to the http: form of a listed https: origin, and one sent it in cleartext), so every engine refuses that form; a host page that sends the directive itself is inherited and is the embedder's choice. A policy text the parser does not understand admits nothing. The other fetch directives narrow in the browser, where the engine applies the inherited list, and are documented under `origins` and in the host-page policy section; a policy list only narrows (CSP3 intersects the lists), so the sandbox's own policy is never weakened",
        by: ['refuse', 'documented'],
        engines: ALL,
        tests: ['test/unit/host-connect.test.ts', 'test/unit/host-policy-source.test.ts', 'test/unit/host.test.ts', 'test/unit/connect-facts.test.ts', 'test/e2e/connect-uniform.spec.ts', 'test/e2e/no-plaintext.spec.ts', 'test/unit/host-page-policy.test.ts', 'test/unit/policy-guarantees.test.ts', 'test/unit/request-gate.test.ts', 'test/e2e/request-gate.spec.ts', 'test/unit/sealed-build.test.ts', 'test/e2e/directive-matrix.spec.ts', 'test/e2e/sealed-no-network.spec.ts', 'test/e2e/sealed-reach.spec.ts'],
        sealed: { standing: 'reduced', note: "no origin is narrowed and no `connect-src` is read: the view's policy has no network source and the request gate admits nothing. Left: the page's `img-src`, `font-src`, `media-src` and `style-src` must admit `blob:` for registered files of that kind, or those loads are refused in the view and reported as `violation`" },
        residuals: {
            blobLoads: {
                what: "a registered file's load in the view (a `blob:` URL the view minted) is checked against the page's `img-src`, `font-src`, `media-src` or `style-src`: one that does not admit `blob:` refuses it, and the element reports it as a `violation`; the guest learns only that its file did not show",
                tests: ['test/e2e/sealed-reach.spec.ts'],
            },
        },
    },
    cspPolicyText: {
        channel: "The host page's CSP list as text (its nonces and hashes, its report endpoint with any key in the URL, its `connect-src` origins, its Trusted Types names): every policy of the inherited list that refuses an action reports it with its text, to the realm (a `securitypolicyviolation` event's `originalPolicy`) and in the engine's error message (Chromium's `EvalError` quotes the refusing directive)",
        inheritedBy: "every mode: the wrapper, the view and the guest's `blob:` worker, which copies the view's list; cooperative mode's guest document",
        how: "No guest code of strict and sealed mode reaches a refusing check of the inherited list: before the entry runs, the prelude puts the library's own `EvalError` in place of every code-from-string sink of the worker, which never calls the platform (CODE_FROM_STRING_SINKS, code-from-strings.ts), and the worker has no other compiler (ABSENT_COMPILERS); the build refuses an entry that calls `import()` with its reason (entry-imports.ts); the request gate refuses every request before the platform, and every other request maker is off the allowlist (sealed-makers.ts). Sealed mode refuses `scriptUnsafe` with its reason. Whatever still raises a violation in the worker is relayed and then stopped by the bootstrap's first capture listener, and every field of `SecurityPolicyViolationEvent.prototype` reads blank to guest code (VIOLATION_EVENT_FIELDS). Strict mode with `scriptUnsafe`, and worker mode, whose guest code runs only through `execute()`, hand strings to the platform: the host page's policy checks them, and Chromium's error text quotes the refusing directive (documented). Cooperative mode's guest document reads its own violations (documented)",
        by: ['construct', 'refuse', 'reason', 'documented'],
        engines: ['chromium', 'firefox'],
        tests: ['test/e2e/sealed-host-policy.spec.ts', 'test/unit/code-from-strings.test.ts', 'test/unit/entry-imports.test.ts', 'src/lib/in-sandbox-script.test.ts', 'test/unit/sealed-mode.test.ts', 'test/unit/egress.test.ts'],
        sealed: { standing: 'remains', note: "the worker reaches no refusing check of it, by construction, and reads no field of a violation; the view runs no guest code" },
    },
    cspReporting: {
        channel: "The host page's CSP reporting endpoints (`report-uri`, `report-to`): every refusing check of the inherited list makes the browser POST a report to the page's endpoint, with fields of the refused action (the blocked URL with its path and query, a sample of a script or a style with `'report-sample'`, and Chromium's Trusted Types sample without it)",
        inheritedBy: "every mode: the view and the guest's worker; cooperative mode's guest document",
        how: "The worker of strict and sealed mode reaches no refusing check (the `cspPolicyText` row), so it makes the browser send no report: no `import()` (the build refuses the entry), no string run as code, no request past the gate. The view runs no guest code, and the renderer drops every network URL before the browser sees it, so no report names one. The view applies the guest's styles through the CSSOM, which no `style-src` checks on any engine: a style attribute as the element's declaration, a `<style>` as a constructed stylesheet it adopts, and its parser is given markup that holds neither, since Chromium checks a style attribute as it parses it (style-markup.ts, sanitizeRender; docs/research/25_cssom_styles). The element's own code, in the host page's realm, hands nothing of a strict or sealed build's guest content to a parser, a loader or a markup sink there, whose policy is the page's: every function of it that receives guest content is a row of HOST_PASSES (host-passes.ts; BD7:LIM-1). What the view still has checked against the host page's policy is the library's own loads of registered files (`blob:`, under the page's `img-src`, `font-src`, `media-src` and `style-src`): a page whose policy refuses them gets a report for each refusal, which names only `blob` as blocked (documented, with what the embedder does: admit `blob:`, docs/API.md#host-page-policy, or serve the embedding page without reporting). Strict mode with `scriptUnsafe`, worker mode and cooperative mode report what their guest code makes the platform refuse (documented)",
        by: ['construct', 'refuse', 'reason', 'documented'],
        engines: ['chromium', 'firefox'],
        tests: ['test/e2e/sealed-host-policy.spec.ts', 'test/e2e/sealed-no-network.spec.ts', 'test/unit/entry-imports.test.ts', 'test/unit/code-from-strings.test.ts', 'test/unit/inline-styles.test.ts', 'test/e2e/sealed-reach.spec.ts', 'test/unit/host-passes.test.ts', 'test/e2e/host-realm-passes.spec.ts'],
        sealed: { standing: 'reduced', note: "no report from the worker, and none of a guest style; the view's `blob:` loads of registered files remain, on a page whose policy refuses `blob:`, each report naming only `blob`" },
        residuals: {
            blobLoads: {
                what: "each refusal of a registered file's load in the view is reported to the page's endpoint, naming `blob` as blocked; how many there are, and when, is the guest's choice",
                tests: ['test/e2e/sealed-reach.spec.ts'],
            },
        },
    },
    trustedTypesRequirement: {
        channel: "The host page's `require-trusted-types-for 'script'` and its `trusted-types` names",
        inheritedBy: 'every mode; in cooperative mode the guest inherits the requirement',
        how: "The library writes every document and worker source through its own policy `web-sandbox` from the first write, never a string to a sink; a `trusted-types` list that does not name it ends the build with a reason that says so, and `execute()`'s string is not evaluated. A browser without Trusted Types (Firefox, at the version measured) cannot do either itself, so the library reads `require-trusted-types-for 'script'` and the `trusted-types` names from the policy text the embedder passes (`hostContentSecurityPolicy`) and refuses alike (host-trusted-types.ts); the library never asks the page for its policy, so without the option nothing is applied there",
        by: ['construct', 'reason', 'refuse'],
        engines: ALL,
        tests: ['test/e2e/host-policy.spec.ts', 'test/e2e/trusted-types-uniform.spec.ts', 'test/e2e/directive-matrix.spec.ts', 'test/unit/host-trusted-types.test.ts'],
        sealed: { standing: 'remains', note: '`hostContentSecurityPolicy` serves only this in sealed mode' },
    },
    trustedTypesDefault: {
        channel: "The host page's Trusted Types default policy (host code that runs inside a library sink)",
        inheritedBy: 'the host realm: the library host code that writes a frame or a worker',
        how: "The library never writes a string to a sink where Trusted Types exist, so the default policy is never asked; a `trusted-types 'default'` the build cannot work around ends it with the Trusted Types reason (a browser without Trusted Types, from `hostContentSecurityPolicy`, as for the requirement)",
        by: ['construct', 'reason'],
        engines: ALL,
        tests: ['test/e2e/host-policy.spec.ts', 'test/e2e/trusted-types-uniform.spec.ts'],
        sealed: { standing: 'remains' },
    },
    coep: {
        channel: "The host page's Cross-Origin-Embedder-Policy and cross-origin isolation (`require-corp`, `credentialless`; COOP)",
        inheritedBy: 'every frame; the strict worker is a `blob:` worker',
        how: 'A guest never runs cross-origin isolated: the element refuses to build on a host page that reads `crossOriginIsolated === true`, before any frame exists, and a bootstrap that reads it stays inert as well (defence in depth); either way the sandbox ends with the isolation reason, on every engine (an isolated host page, COOP and COEP together, is not supported; environment-check.ts). COEP alone does not isolate the page and is documented: WebKit refuses the view\'s `blob:` worker under `require-corp`, so a strict build there ends with the worker reason; Chromium and Firefox build',
        by: ['check', 'reason', 'documented'],
        engines: ['chromium', 'firefox', 'webkit'],
        environmentChecks: ['isolated'],
        tests: ['test/e2e/host-policy.spec.ts', 'test/e2e/realistic-host.spec.ts', 'test/e2e/directive-matrix.spec.ts', 'test/unit/environment-check.test.ts', 'test/unit/environment-gate.test.ts'],
        sealed: { standing: 'remains', note: "`crossOriginIsolated` is the one value of the host page's that sealed mode reads, only to refuse" },
    },
    referrer: {
        channel: "The host page's URL as a referrer, and the engines' own referrer exceptions for same-site targets",
        inheritedBy: 'every mode: requests of the frames, the worker and rendered markup',
        how: "The frames are `no-referrer`, the wrapper carries a `no-referrer` meta and `<base href=\"about:blank\">`, and the strict renderer forces `referrerpolicy=\"no-referrer\"`; cooperative mode's residuals (a guest asking for `unsafe-url`) are documented",
        by: ['construct', 'documented'],
        engines: ALL,
        tests: ['test/e2e/host-url.spec.ts', 'test/e2e/sealed-no-network.spec.ts'],
        sealed: { standing: 'not-applicable', because: 'no-network', note: 'no request leaves; the `no-referrer` settings stay' },
    },
    ancestorOrigins: {
        channel: '`location.ancestorOrigins`: the host origin, shown to a document nested in the host page',
        inheritedBy: 'cooperative mode (strict mode has no guest document)',
        how: 'Documented as a cooperative limit; the host origin is not a secret',
        by: ['documented'],
        engines: ['chromium', 'webkit'],
        tests: ['test/e2e/host-url.spec.ts'],
        sealed: { standing: 'not-applicable', because: 'no-guest-document', note: 'cooperative mode only' },
    },
    documentOrigin: {
        channel: "The document's origin, URL and storage: the library's own text, which the host page's `script-src` admits, runs wherever it is copied",
        inheritedBy: 'every bootstrap that runs in a sandbox document (view, bridge frame, cooperative guest, worker mode\'s frame)',
        how: "Every bootstrap's first statement reads `self.origin` (`'null'`) and `location.href` (`about:srcdoc`) and stays inert on any other document: a sandbox frame without `allow-same-origin` has no host storage, cookies or DOM, and a copy in the host page does nothing",
        by: ['check', 'construct'],
        engines: ALL,
        environmentChecks: ['origin', 'url'],
        tests: ['test/e2e/environment-check.spec.ts', 'test/unit/environment-check.test.ts', 'test/unit/environment-gate.test.ts', 'test/e2e/security.spec.ts'],
        sealed: { standing: 'remains' },
    },
    cookies: {
        channel: "The host site's cookies: a request of a sandbox document is made for the host page's site, so a cookie the browser attaches by site (SameSite=None; on some engines Lax and Strict) rides on it; likewise the user's other ambient credentials for the origin, cached HTTP authentication and a TLS client certificate (AMBIENT_CREDENTIALS, not measured)",
        inheritedBy: "cooperative and worker mode: the guest's own requests to a listed origin that the library cannot strip: a WebSocket handshake, and in cooperative mode the loads of its markup and CSS, `sendBeacon()`, `EventSource`, `<a ping>` and the requests of a frame the guest creates (`COOKIE_CARRIERS`). No request of strict mode (`STRICT_COOKIE_CARRIERS`: none), and no `fetch` or `XMLHttpRequest` in any mode; the fetch bridge sends none",
        how: `The guest's \`fetch()\` and \`XMLHttpRequest\` never send credentials, on any engine: the bootstrap's request gate makes every fetch with \`credentials: 'omit'\` and keeps \`withCredentials\` false (in-sandbox-script.ts, S74). Strict mode's view makes no load with credentials, on any engine, by construction: the renderer gives every \`img\`, \`video\`, \`audio\` and \`link\` it keeps \`crossorigin="anonymous"\` before the element is connected (a CORS request carries no cookie of any SameSite kind), and keeps no network URL where no attribute reaches (a \`poster\`, which Firefox loads without CORS; every URL of CSS, registered stylesheets included), reporting each one dropped and each load that fails (in-sandbox-view.ts, RENDER_CROSSORIGIN_ELEMENTS; docs/research/21_crossorigin_loads). Strict mode's worker opens no WebSocket: \`origins.connect\` keeps no \`wss://\` entry there, and the request gate refuses every \`WebSocket\` (origins.ts, in-sandbox-script.ts). In cooperative and worker mode a WebSocket handshake, and in cooperative mode a load of an element or of CSS and the other requests of COOKIE_CARRIERS, cannot be stripped. The wrapper iframe is \`credentialless\` in every mode: where the engine honours it (${CREDENTIALLESS_ENGINES}) it, and everything nested in it, has an empty cookie jar, so no request of the sandbox carries a cookie (its popups open without an opener). Elsewhere those requests would carry it, so an \`origins\` entry on the host page's site is dropped in every mode, with a warning (once per kind), where the host page's site is that of every origin an engine may decide it from: the page's origin as the element's realm has it (\`self.origin\`), its top-level URL's and every ancestor's (\`location.ancestorOrigins\`, else read up \`parent\`), with no probe, by a rule that never misses an origin the browser counts as on the site (host-site.ts: the page's host, or a host that shares its last two labels; an address, \`localhost\` or a single label only itself). Where one of those origins is opaque or cannot be read, the site is undecided, and every entry a request of COOKIE_CARRIERS can reach in the mode is dropped too, with a warning (BD4:ISO-1, BD4:ISO-3); to another site they carry that site's own cookies where the engine sends them (documented: a listed \`wss://\` server must check \`Origin\`). The fetch bridge (\`credentials: 'omit'\`) is the way to reach an API that knows the user. What each engine sends: cookie-facts.ts`,
        by: ['construct', 'credentialless', 'refuse', 'warn', 'documented'],
        engines: ALL,
        tests: ['test/e2e/cookies.spec.ts', 'test/e2e/request-gate.spec.ts', 'test/e2e/view-credentials.spec.ts', 'test/e2e/host-site.spec.ts', 'test/e2e/host-site-layouts.spec.ts', 'test/unit/view-credentials.test.ts', 'test/unit/cookie-facts.test.ts', 'test/unit/request-gate.test.ts', 'test/unit/host-site.test.ts', 'test/unit/host.test.ts', 'test/unit/config-schema.test.ts', 'test/unit/host-origin-wiring.test.ts', 'test/e2e/fetch-bridge.spec.ts', 'test/e2e/sealed-no-network.spec.ts'],
        sealed: { standing: 'not-applicable', because: 'no-network', note: "no request leaves, and the host page's site is never read; the wrapper stays `credentialless`" },
    },
    serviceWorker: {
        channel: "The host page's Service Worker (a cache-first one answers from the app's cache)",
        inheritedBy: 'every frame and worker; the fetch bridge, which the library makes from the host page',
        how: "A sandboxed frame has an opaque origin, which no Service Worker controls; the fetch bridge runs in a frame of its own, so the host page's Service Worker and `fetch` wrappers never apply to it",
        by: ['construct'],
        engines: ALL,
        tests: ['test/e2e/fetch-bridge-isolation.spec.ts', 'test/e2e/security.spec.ts', 'test/e2e/sealed-no-network.spec.ts'],
        sealed: { standing: 'not-applicable', because: 'no-network', note: 'no request and no bridge frame' },
    },
    hostRealmGlobals: {
        channel: "The host realm's globals and prototypes that the library's host code uses (`fetch`, `console`, built-ins)",
        inheritedBy: "the library's host code (host.ts, the bridge's transport)",
        how: "The fetch bridge's requests are made by its own frame, not by the host page's `fetch`; host code reads guest data through captured intrinsics and never calls a function the guest could have replaced",
        by: ['construct'],
        engines: ALL,
        tests: ['test/e2e/fetch-bridge-isolation.spec.ts', 'test/unit/bootstrap-capture-and-measure.test.ts', 'test/unit/guest-realm-hardening.test.ts'],
        sealed: { standing: 'remains', note: "host code reads guest data through captured intrinsics; the bridge's half does not apply" },
    },
    permissionsPolicy: {
        channel: "The host page's Permissions-Policy and the frame's `allow` attribute",
        inheritedBy: 'every mode: the wrapper and the guest frame',
        how: 'The `allow` attributes come from a closed list of capabilities the embedder names; nothing else is delegated, and a host Permissions-Policy only narrows',
        by: ['construct'],
        engines: ALL,
        tests: ['test/e2e/capability-presets.spec.ts', 'test/unit/host.test.ts'],
        sealed: { standing: 'remains', note: 'no feature is delegated, as in strict mode' },
    },
    permissionState: {
        channel: "The browser's per-origin state about the host page: the permissions the user granted its origin (geolocation, notifications, push; camera and microphone read `denied` once any is granted), which an engine may answer a realm of the sandbox from",
        inheritedBy: "strict, sealed and worker mode: the guest's `blob:` worker (WebKit answered `navigator.permissions.query()` there with the host origin's grants); cooperative mode: the guest document (Chromium and WebKit)",
        how: "The worker has no permission API: `navigator.permissions`, `Permissions` and `PermissionStatus` are off the allowlist, and so are `navigator.storage` and `StorageManager` (WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS); no API a permission gates exists there. Every kept name that reads browser state keyed to an origin or the profile is classified with its measured answer, the same with and without the host origin's state (SEALED_REACH, the `permissionState` column, sealed-reach.ts). Cooperative mode's guest document is a sandboxed frame the library does not prune: there the grants are readable on Chromium and WebKit, a documented cooperative limit",
        by: ['construct', 'documented'],
        engines: ['chromium', 'webkit'],
        tests: ['test/e2e/realistic-host.spec.ts', 'test/unit/sealed-reach.test.ts', 'test/e2e/worker-globals-and-termination.spec.ts'],
        sealed: { standing: 'remains', note: 'closed by construction: the worker has no permission API, and the view runs no guest code' },
    },
    secureContext: {
        channel: "Whether the host page is a secure context: a document is one when its top-level page's URL is potentially trustworthy (`https:`, or a loopback host), and a worker when its owner is, so `isSecureContext`, and every interface the platform offers only in a secure context, tell a realm of the sandbox which kind of URL the host page was served from",
        inheritedBy: "every frame and worker; worker mode's `blob:` worker and cooperative mode's guest document on Firefox and WebKit (Chromium counts the worker as not secure on every page); strict and sealed mode's worker has nothing that depends on it",
        how: "Strict and sealed mode's worker has nothing only a secure context has, and reads `isSecureContext` as false, on every engine and whatever the host page: the secure-context-only globals and navigator members are off its allowlists, and the prelude deletes the members of kept interfaces and pins `isSecureContext` (SECURE_CONTEXT_ONLY, removeSecureContextOnly, worker-globals.ts). That is the surface Chromium's worker has on every page, so the guest's API is the same on every engine and no host page changes it. The e2e suite compares the sealed worker of a host page served from a name that is not potentially trustworthy with one on a loopback host, every global and every member it leads to, on every engine, and fails on any difference. Worker mode's worker and cooperative mode's guest document follow the page's URL on Firefox and WebKit: one bit, which every visitor of the page sees in the address bar (documented)",
        by: ['construct', 'documented'],
        engines: ['firefox', 'webkit'],
        tests: ['test/e2e/sealed-reach.spec.ts', 'test/unit/sealed-reach.test.ts', 'src/lib/worker-globals.test.ts'],
        sealed: { standing: 'remains', note: 'closed by construction: the worker has nothing only a secure context has, and reads `isSecureContext` as false, on every engine' },
    },
    uiSurfaces: {
        channel: "The browser's shared UI surfaces: focus, the clipboard, history, top-level navigation, the host window as a `postMessage` target",
        inheritedBy: 'cooperative and worker mode (strict mode has no guest document)',
        how: 'No `allow-top-navigation*` flag; the guest cannot move the host page through history or name its frame. Focus, the clipboard after a user\'s click and messages to the host window are documented cooperative limits (S36, S44)',
        by: ['construct', 'documented'],
        engines: ALL,
        tests: ['test/e2e/guest-realm-hardening.spec.ts', 'test/e2e/strict.spec.ts'],
        sealed: { standing: 'not-applicable', because: 'no-guest-document', note: "cooperative and worker mode only; the view's focus rule (`set({ focus })`) stays" },
    },
    eventDispatch: {
        channel: 'Events the browser dispatches synchronously into the host page when a frame is removed (focus, blur, pagehide)',
        inheritedBy: "the host page's listeners, during the element's teardown",
        how: "The teardown detaches the old environment before it releases anything, so a listener that calls `reset()` or `terminate()` re-enters a consistent element",
        by: ['construct'],
        engines: ALL,
        tests: ['test/e2e/teardown-reentry.spec.ts', 'test/unit/teardown-reentry.test.ts', 'test/e2e/realistic-host.spec.ts'],
        sealed: { standing: 'remains' },
    },
    thread: {
        channel: "The host page's thread and process: the strict view and the cooperative frame can share them",
        inheritedBy: 'strict mode on Firefox, WebKit, Android and the headless shell; cooperative mode on WebKit and in some Chromium environments',
        how: 'Documented: availability is a stated bound (the view\'s budgets, the repeated-overrun rule), and `terminate()` or removing the element gives the host page back',
        by: ['documented'],
        engines: ALL,
        tests: ['test/e2e/view-bound.spec.ts', 'test/unit/view-bound.test.ts', 'test/e2e/view-budget.spec.ts'],
        sealed: { standing: 'remains', note: "the view shares the host page's thread as strict mode's does" },
        residuals: {
            viewRendering: {
                what: "what the guest renders and sets is applied in the view, on the host page's thread on Firefox, WebKit, Android WebView and Chromium's headless shell: an availability cost, bounded by the view's budgets and the repeated-overrun rule (docs/API.md, the view's cost to the host page)",
                tests: ['test/e2e/view-bound.spec.ts', 'test/unit/view-bound.test.ts', 'test/e2e/view-budget.spec.ts'],
            },
            hostPasses: {
                what: "the element's own passes over guest content (HOST_PASSES: the config's `html`, the entry, the registered files, the guest's frames) run in the host page's realm, on its thread, on every engine: each linear in what it takes, which a cap of the library's bounds (VIEW_RENDER_MAX_LENGTH, MAX_TOTAL_BYTES, RPC_MAX_INBOUND_BYTES and the rest), so an availability cost of a build or a frame (BD7:LIM-2)",
                tests: ['test/unit/host-passes-scaling.test.ts', 'test/unit/host-passes.test.ts'],
            },
        },
    },
} as const satisfies Record<string, InheritedContextRow>;

export type InheritedContextId = keyof typeof INHERITED_CONTEXT;

/** The rows in table order, with their ids. */
export const inheritedContextRows = (): Array<InheritedContextRow & { readonly id: InheritedContextId }> =>
    (Object.keys(INHERITED_CONTEXT) as InheritedContextId[]).map(id => ({ id, ...(INHERITED_CONTEXT[id] as InheritedContextRow) }));
