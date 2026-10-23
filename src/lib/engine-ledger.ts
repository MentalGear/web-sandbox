/**
 * The engine-difference ledger: one row for every difference between Chromium, Firefox and WebKit that the library or
 * its tests still observe. A difference is either made uniform (and leaves the ledger) or stays, and then it has a row
 * here: what differs, what each engine does, why it stays, and the specs that pin it.
 *
 * Values first: this is the one list. The table of docs/THREAT-MODEL.md ("Engine differences that change a guarantee")
 * is rendered from it (`bun run docs:gen`), and `test/unit/engine-ledger.test.ts` keeps the specs honest: every
 * `browserName`-dependent branch, per-engine map or `engines:` override under `test/e2e/` cites the id of its row in a
 * `// ledger: <id>` comment, no cited id is unknown, and every row is cited by each spec it names. An engine difference
 * can therefore not enter the suite silently.
 *
 * Two rows state values that live in tables of their own, `COOKIE_ENGINE_FACTS` and `CONNECT_ENGINE_FACTS`; their cells
 * are rendered from those tables, so no engine's behaviour is stated twice.
 *
 * Internal: not exported from the package.
 */
import { COOKIE_ENGINES, engineClause } from './cookie-facts';
import { CONNECT_ENGINE_FACTS, CONNECT_ENGINES } from './connect-facts';

export interface EngineDifference {
    /** What differs, in a phrase. */
    readonly what: string;
    /** What each engine does. */
    readonly chromium: string;
    readonly firefox: string;
    readonly webkit: string;
    /** Why it stays (the layer it comes from) and what the library does about it. */
    readonly why: string;
    /** The specs that pin it; each one carries a `// ledger: <id>` comment. */
    readonly tests: readonly string[];
}

const cookie = (engine: (typeof COOKIE_ENGINES)[number]) => engineClause(engine, 'sameSite', undefined, false).replace(/^[^:]+: /, '') + ' to the host page\'s site (the table below)';
const connect = (engine: (typeof CONNECT_ENGINES)[number]) => {
    const facts = CONNECT_ENGINE_FACTS[engine];
    return `a \`'self'\` source ${facts.selfAdmitsOtherOrigins ? 'admits' : 'does not admit'} an origin it does not name; a host without a scheme: ${facts.bareHostAdmitted}; \`wss://h\` ${facts.wssSourceAdmitsHttps ? 'also admits' : 'does not admit'} \`https://h\``;
};

const E2E = 'test/e2e/';

/** The ledger, by row id. */
export const ENGINE_DIFFERENCES = {
    'view-thread': {
        what: "Where the strict view runs, so whether a view stall stalls the host page",
        chromium: "Its own process on the desktop (127+); the host page's thread in the headless shell and on Android",
        firefox: "The host page's thread",
        webkit: "The host page's thread",
        why: "The browser's process model. Isolation cannot be emulated; the bound on the view's cost (docs/API.md) is stated for every engine, and availability, not isolation, is what it promises",
        tests: [`${E2E}view-bound.spec.ts`],
    },
    'cooperative-thread': {
        what: "Whether a cooperative frame shares the host page's thread",
        chromium: "Its own process in some environments, the host's thread in others",
        firefox: "Not fixed: the suite measures it per run",
        webkit: "The host page's thread",
        why: "Browser policy, not the page's to set. A cooperative guest loop can freeze the host page where it shares the thread; strict mode, whose guest code runs in a worker, is the answer",
        tests: [`${E2E}watchdog.spec.ts`],
    },
    'firefox-rejection-reports': {
        what: "Who pays for a worker's unhandled rejections and uncaught errors",
        chromium: "Nothing once the worker cancels them",
        firefox: "Reports every rejection on the host page's thread, cancelled or not",
        webkit: "Nothing once the worker cancels them",
        why: "Firefox reports before anything in the worker can stop it. The uncaught budget (`UNCAUGHT_PER_SECOND`, `UNCAUGHT_CHARACTERS_PER_SECOND`) ends the sandbox instead",
        tests: [`${E2E}error-cost-and-queued-calls.spec.ts`],
    },
    'webkit-muted-errors': {
        what: "The text of an uncaught error of a revoked script or of code compiled from a string",
        chromium: "The error and its text, in the worker and in cooperative mode",
        firefox: "The error and its text, in the worker and in cooperative mode",
        webkit: "`Script error.` in cooperative mode's inline scripts and in worker mode's worker; strict mode's view relays the real text and counts its characters in the uncaught budget",
        why: "WebKit mutes errors whose script it cannot resolve to the document's origin. Worker mode has no view to count in, and cooperative mode no API; the line is the browser's",
        tests: [`${E2E}relay-and-rpc-budgets.spec.ts`, `${E2E}error-cost-and-queued-calls.spec.ts`],
    },
    'worker-violation-reports': {
        what: "`securitypolicyviolation` reports raised inside a worker (`source: 'logic'`) for `fetch` and `importScripts`",
        chromium: "Both, with `connect-src` and `script-src-elem`",
        firefox: "`fetch` only; an `importScripts` refusal reaches the creating document (in strict mode, the view's report)",
        webkit: "None",
        why: "WebKit raises no violation event in workers, and Firefox routes `importScripts` refusals to the creating document. Reports from the guest's realm are claims, and the refusal itself is the same on every engine",
        tests: [`${E2E}violations.spec.ts`, `${E2E}worker-security.spec.ts`, `${E2E}host-site.spec.ts`, `${E2E}blob-delivery.spec.ts`],
    },
    'worker-eventsource-fontface': {
        what: "A worker the guest makes in cooperative mode: its `EventSource` and `FontFace` against the policy",
        chromium: "Refused by the policy",
        firefox: "Sent and loaded past the policy",
        webkit: "Refused by the policy",
        why: "A platform gap in Firefox's worker policy checks. A worker the guest makes is a realm the library never reaches; the library's own worker allowlist leaves both out",
        tests: [`${E2E}worker-globals-and-termination.spec.ts`],
    },
    'webassembly-unsafe-eval': {
        what: "Compiling WebAssembly without `'unsafe-eval'`",
        chromium: "Refused",
        firefox: "Refused",
        webkit: "Compiles",
        why: "WebKit's policy check. The library deletes `WebAssembly` from the worker unless `scriptUnsafe`",
        tests: [`${E2E}strict-entry-scope-and-links.spec.ts`],
    },
    'coep-require-corp': {
        what: "A host page with `Cross-Origin-Embedder-Policy: require-corp` (without COOP)",
        chromium: "Strict mode runs",
        firefox: "Strict mode runs",
        webkit: "Refuses the view's `blob:` worker; the build ends with the worker-refused reason",
        why: "WebKit applies a CORP check to a `blob:` worker made by an opaque-origin document, and a blob has no CORP header. No API reads a page's COEP, so the library cannot decide before the build",
        tests: [`${E2E}host-policy.spec.ts`, `${E2E}directive-matrix.ts`],
    },
    'coop-coep-isolation': {
        what: "Which COOP and COEP pairs make the host page cross-origin isolated, which the library refuses on every engine",
        chromium: "COOP `same-origin` isolates the page with `require-corp` or `credentialless`",
        firefox: "Isolates the page with `require-corp` or `credentialless`",
        webkit: "Isolates it with `require-corp` only; with `credentialless` the page is not isolated and the sandbox runs",
        why: "Which pairs isolate a page is the browser's. The library reads `crossOriginIsolated` of the page, so the outcome follows the page's isolation, never the engine",
        tests: [`${E2E}directive-matrix.ts`],
    },
    'ancestor-origins': {
        what: "`location.ancestorOrigins` in a cooperative guest",
        chromium: "Lists the host origin",
        firefox: "No such property",
        webkit: "Lists the host origin",
        why: "The page cannot set it, and a no-referrer policy does not mask it. A documented limit of cooperative mode, whose list is frozen (S44)",
        tests: [`${E2E}host-url.spec.ts`, `${E2E}realistic-host.spec.ts`],
    },
    'referrer-of-nested-frame': {
        what: "The referrer of a frame the guest makes (cooperative)",
        chromium: "Empty",
        firefox: "Empty",
        webkit: "The host page's URL without its fragment",
        why: "WebKit takes a navigation's referrer from the first non-`srcdoc` document up the tree, with no check for the opaque origin between. No document or attribute the library controls changes that (S17, S18)",
        tests: [`${E2E}host-url.spec.ts`],
    },
    'referrer-on-requests': {
        what: "The referrer on a request of the sandbox, and on the host page's own cross-site `unsafe-url` request",
        chromium: "None from the sandbox (an opaque origin has no referrer); the host page's own request carries the full URL",
        firefox: "The host origin on image requests where the policy in force allows a referrer; the host page's own request carries the origin",
        webkit: "As Firefox",
        why: "How each engine treats an opaque-origin referrer. A guest can ask for a referrer per request or with its own `<meta>`, and no document can stop that",
        tests: [`${E2E}host-url.spec.ts`],
    },
    'popup-opener': {
        what: "A popup opened with `allow-popups` (cooperative)",
        chromium: "`window.open()` returns `null` and the popup opens without an opener",
        firefox: "`window.open()` returns the window; the opener is kept",
        webkit: "`window.open()` returns the window; the opener is kept",
        why: "Chromium's credentialless frames force `noopener`. A patch of the realm would be bypassable from a frame the guest makes",
        tests: [`${E2E}capability-presets.spec.ts`],
    },
    'trusted-types': {
        what: "A host page's Trusted Types requirement",
        chromium: "Applied: the build ends when the page's `trusted-types` list omits `web-sandbox`, and `execute()` is refused",
        firefox: "No Trusted Types (146): nothing is applied unless `hostContentSecurityPolicy` gives the policy, from which the library refuses as the others do",
        webkit: "Applied, as Chromium",
        why: "A feature missing in Firefox. `hostContentSecurityPolicy` lets the library decide the same way where the browser cannot; a Firefox that ships Trusted Types is governed like the others",
        tests: [`${E2E}host-policy.spec.ts`, `${E2E}trusted-types-uniform.spec.ts`],
    },
    'cookies': {
        what: "Cookies sent with a request of the sandbox to a listed origin on the host page's site (and on another site)",
        chromium: cookie('chromium'),
        firefox: cookie('firefox'),
        webkit: cookie('webkit'),
        why: "Only Chromium honours `credentialless` on the wrapper frame. A same-site entry of `origins` is dropped in every mode; `fetchBridge` sends no cookie on any engine",
        tests: [`${E2E}cookies.spec.ts`],
    },
    'connect-src': {
        what: "What the host page's `connect-src` sources admit in a sandbox document",
        chromium: connect('chromium'),
        firefox: connect('firefox'),
        webkit: connect('webkit'),
        why: "The engines read some sources differently. The library applies the page's policy to `origins.connect` and `fetchBridge.allow` itself, and lists a `wss://` entry only beside its `https://` twin, so the outcome is one on every engine",
        tests: [`${E2E}connect-uniform.spec.ts`],
    },
    'secure-cookie-over-http': {
        what: "A `Secure` cookie sent to the test suite's plain-http listener (the suite, not the library)",
        chromium: "Sent",
        firefox: "Sent",
        webkit: "Stored but not sent to an http origin",
        why: "WebKit refuses a Secure cookie over http; a production host page is https. The suite expects what the engine sends",
        tests: [`${E2E}realistic-host.spec.ts`],
    },
    'blob-type-emptied': {
        what: "A Blob or File `type` of 65 536 characters or more",
        chromium: "Emptied when the object is made: the guest holds a Blob of no type, which is sent as it is",
        firefox: "Kept whole, and refused as over `BLOB_TYPE_MAX_LENGTH`",
        webkit: "Kept whole, and refused as over `BLOB_TYPE_MAX_LENGTH`",
        why: "Chromium normalises the type before the library sees the object. Up to 65 535 characters every engine builds the same Blob, and the measure refuses a type over `BLOB_TYPE_MAX_LENGTH` on all of them",
        tests: [`${E2E}exact-budget.spec.ts`],
    },
    'unresolved-import-events': {
        what: "A stylesheet `@import` or a `srcset` that cannot resolve: the events, and what the CSSOM shows",
        chromium: "The link fires `error`; the import rule's sheet is unreadable (`SecurityError`); the `<img>` fires `error`",
        firefox: "The link fires `load`; the sheet is empty; the `<img>` fires no event",
        webkit: "The link fires `error`; the rule has no sheet; the `<img>` fires `error`",
        why: "Each engine's own handling of a URL that cannot resolve. Nothing loads and nothing is requested on any of them",
        tests: [`${E2E}files.spec.ts`],
    },
    'import-scripts-mime': {
        what: "`importScripts` of a registered file whose type is not JavaScript (worker mode)",
        chromium: "Runs it",
        firefox: "Refuses it (`NetworkError`)",
        webkit: "Refuses it (`NetworkError`)",
        why: "Chromium skips the HTML spec's MIME check for classic worker imports. The file is the embedder's, so the guest gains nothing",
        tests: [`${E2E}inert-files-and-smil.spec.ts`, `${E2E}blob-delivery.spec.ts`],
    },
    'module-worker-opaque-blob': {
        what: "A module worker the guest starts from a `blob:` URL it made (cooperative)",
        chromium: "Refused, with a bare error event and no policy violation",
        firefox: "Starts",
        webkit: "Starts",
        why: "Chromium refuses a module worker whose `blob:` URL was made in an opaque-origin document, under any policy. The default policy's `worker-src` is not the cause",
        tests: [`${E2E}blob-delivery.spec.ts`],
    },
    'import-map-later': {
        what: "A second import map in a guest document",
        chromium: "Honoured",
        firefox: "Ignored: only the first map counts, and none once a module script was prepared",
        webkit: "Honoured",
        why: "Firefox 146 honours one import map per document",
        tests: [`${E2E}blob-delivery.spec.ts`],
    },
    'blob-module-literal-key': {
        what: "A relative specifier inside a `blob:` module, against the guest's own literal import-map keys",
        chromium: "`TypeError`",
        firefox: "Resolves through the key",
        webkit: "Resolves through the key",
        why: "How each engine resolves a specifier against a `blob:` base URL. Nothing outside the guest's own map is reached",
        tests: [`${E2E}blob-delivery.spec.ts`],
    },
    'cross-origin-worker-errors': {
        what: "How a refused cross-origin worker URL, or `importScripts` of one, reports",
        chromium: "`new Worker()` throws `SecurityError`; `importScripts` fails with `NetworkError`",
        firefox: "`new Worker()` fires `error`; `importScripts` throws `SecurityError`",
        webkit: "`new Worker()` fires `error`; `importScripts` fails with `NetworkError`",
        why: "Each engine's own exception type. The load is refused on all three",
        tests: [`${E2E}blob-delivery.spec.ts`],
    },
    'blob-mime-checks': {
        what: "MIME checks on `blob:` stylesheets and classic scripts the guest loads",
        chromium: "A `text/plain` stylesheet fires `load` but is not applied; a classic script of type `image/png` runs",
        firefox: "A `text/plain` stylesheet fires `error`; a classic script of type `image/png` runs",
        webkit: "A `text/plain` stylesheet fires `error`; a classic script of type `image/png` is refused",
        why: "Each engine's own MIME checks for `blob:` loads. The policy refuses these loads by default; the difference shows only when an embedder admits them",
        tests: [`${E2E}blob-delivery.spec.ts`],
    },
    'refused-navigation-history': {
        what: "A frame navigation the wrapper's policy refuses (cooperative)",
        chromium: "Commits an error page: one history entry, and the frame holds `chrome-error://`",
        firefox: "No history entry",
        webkit: "No history entry",
        why: "Chromium's error page for a blocked frame navigation. The guest document is gone on every engine that commits one",
        tests: [`${E2E}worker-globals-and-termination.spec.ts`, `${E2E}blob-delivery.spec.ts`],
    },
    'nested-frame-history': {
        what: "`history.back()` from a frame the guest makes (cooperative)",
        chromium: "Does not traverse the tab's history",
        firefox: "Traverses it",
        webkit: "Traverses it",
        why: "Each browser's rules for session history of nested frames. One of cooperative mode's documented limits (S44)",
        tests: [`${E2E}guest-realm-hardening.spec.ts`],
    },
    'modifier-click-links': {
        what: "A user's modifier click or Enter on a guest link or form (cooperative, without `allow-popups`)",
        chromium: "Opens a new tab at the guest's URL with or without a gesture; submits a form in a new tab past `form-action 'none'` with `allow-forms`",
        firefox: "Opens a new tab after a user click; no form submission",
        webkit: "Opens none",
        why: "How each browser treats a user's gesture in a sandboxed frame; no policy governs the new tab. Strict mode renders inert links",
        tests: [`${E2E}relay-and-rpc-budgets.spec.ts`, `${E2E}worker-globals-and-termination.spec.ts`],
    },
    'meta-refresh-termination': {
        what: "How a guest's `<meta http-equiv=refresh>` ends the sandbox (cooperative)",
        chromium: "A second announcement from the new document",
        firefox: "The frame refreshes to a document without a bootstrap, so no second announcement: the watchdog ends it",
        webkit: "A second announcement from the new document",
        why: "Firefox refreshes the frame to a document the bootstrap never ran in. The sandbox ends on every engine; only the reason differs",
        tests: [`${E2E}guest-realm-hardening.spec.ts`],
    },
    'keepalive-fetch': {
        what: "`fetch` with `keepalive` past `connect-src`",
        chromium: "The guarded `fetch` refuses it, with a `Request` too",
        firefox: "A `Request` does not keep `keepalive` (its getter reads false), so it is an ordinary request that `connect-src` refuses; a frame the guest makes still sends its `keepalive` request past `connect-src`",
        webkit: "The guarded `fetch` refuses it, with a `Request` too",
        why: "Firefox sends keepalive requests without checking `connect-src` (a platform bug); the guarded `fetch` of the guest realm closes it there, and a frame the guest makes has the platform's `fetch`",
        tests: [`${E2E}guest-realm-hardening.spec.ts`],
    },
    'preconnect': {
        what: "`<link rel=preconnect>` to an origin the policy blocks (cooperative)",
        chromium: "No connection",
        firefox: "No connection",
        webkit: "Opens a connection; no request is sent",
        why: "WebKit's preconnect does not consult `connect-src`; a connection carries no data of the guest's",
        tests: [`${E2E}guest-realm-hardening.spec.ts`],
    },
    'focus-and-clipboard': {
        what: "Guest focus and the clipboard (cooperative)",
        chromium: "Guest keystrokes reach the guest after it takes focus; `writeText()` is refused, `execCommand('copy')` works after a click",
        firefox: "Focus moves to the element but keystrokes do not reach the guest; `writeText()` works after a click",
        webkit: "The host page keeps focus; `writeText()` is refused after a click and works in the click's own handler",
        why: "Each browser's focus and user-activation rules for an opaque-origin frame. Residuals of cooperative mode (S36)",
        tests: [`${E2E}guest-realm-hardening.spec.ts`],
    },
    'ping-attribute': {
        what: "`<a ping>` in the guest document",
        chromium: "Sends the ping to an allowed origin; a blocked one is a `connect-src` violation",
        firefox: "Pings are off by default: nothing is sent, nothing is refused",
        webkit: "As Chromium",
        why: "Firefox's `browser.send_pings` is off. Nothing leaves in any engine to an origin the policy blocks",
        tests: [`${E2E}hard-security.spec.ts`],
    },
    'discarded-directives-console': {
        what: "The console line for a CSP directive the browser discards",
        chromium: "Prints one for each discarded directive (the suite's positive control)",
        firefox: "None",
        webkit: "None",
        why: "Diagnostics only. The library's policies contain no discarded directive, which the spec shows on Chromium",
        tests: [`${E2E}guard-rails.spec.ts`],
    },
    'form-submit-event': {
        what: "A `submit` event on a form in a frame without `allow-forms`",
        chromium: "None",
        firefox: "None",
        webkit: "Dispatched, though no submission starts",
        why: "A WebKit platform behaviour; the flag stays dropped and nothing is submitted",
        tests: [`${E2E}allow-forms-and-view-writes.spec.ts`],
    },
    'form-control-parts': {
        what: "The style an engine computes for a form control's user-agent parts (`::file-selector-button`, the range thumb)",
        chromium: "The file button's part",
        firefox: "The file button's and the range thumb's parts",
        webkit: "None: the suite compares the element's pixels in time instead",
        why: "Which parts an engine exposes to the CSSOM. The still stylesheet covers them all; the host page's ticks are the evidence on every engine",
        tests: [`${E2E}view-switches.spec.ts`],
    },
    'focus-during-removal': {
        what: "The host window's `focus` event while a frame is being removed",
        chromium: "Not fired inside the removal",
        firefox: "Fired inside the removal: the teardown is re-entered",
        webkit: "Not fired inside the removal",
        why: "Event timing of the engine. Teardown is re-entrancy-safe either way (the spec asserts the nested build stood)",
        tests: [`${E2E}teardown-reentry.spec.ts`],
    },
    'view-frame-access': {
        what: "How the suite reads the strict view's frames (the suite, not the library)",
        chromium: "Through the DevTools protocol: the view may be out of process, which Playwright links unreliably; the accessibility role is checked from HTML-AAM facts",
        firefox: "Playwright's frame API and `getByRole`",
        webkit: "Playwright's frame API and `getByRole`",
        why: "A tooling limit. The observable behaviour asserted is the same on all three",
        tests: [`${E2E}strict-view.ts`, `${E2E}inert-files-and-smil.spec.ts`, `${E2E}strict-entry-scope-and-links.spec.ts`, `${E2E}worker-port-and-view-cost.spec.ts`],
    },
    'service-worker-control': {
        what: "Whether the suite's Service Worker controls the harness page (the suite, not the library)",
        chromium: "Controls it",
        firefox: "Playwright's Firefox: it never controls the harness, so the positive control shows nothing",
        webkit: "Controls it",
        why: "A tooling limit; the spec records it as an annotation where it applies",
        tests: [`${E2E}fetch-bridge-isolation.spec.ts`],
    },
} as const satisfies Record<string, EngineDifference>;

export type EngineDifferenceId = keyof typeof ENGINE_DIFFERENCES;

/** The ids, in ledger order. */
export const ENGINE_DIFFERENCE_IDS = Object.keys(ENGINE_DIFFERENCES) as EngineDifferenceId[];
