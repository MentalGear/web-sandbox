/**
 * Sealed mode's policy and its check (design 03, "The policies in force" and "What the policy check provokes"; I18). The
 * served file's one policy is its `<meta>`, whose text is one constant per library version: POLICY_DIRECTIVES, one row
 * per directive. A policy on the file's response (a `Content-Security-Policy` or `Content-Security-Policy-Report-Only`
 * header, a site-wide one the usual way) applies to the file's document as well, and the view and its workers inherit it
 * beside the `<meta>`. So the view checks, before it announces itself, that every policy in force is the file's own:
 *
 * - **What it provokes** (POLICY_CANARIES, derived from POLICY_DIRECTIVES: a row per directive, which the types and
 *   test/unit/policy-check.test.ts hold to the `<meta>`'s text): per directive, a load the `<meta>` admits (a `blob:` URL
 *   of the view's own, or its canary worker), which a stricter policy refuses; a load the `<meta>` refuses, which raises
 *   the `<meta>`'s own violation and, under a policy that would report a guest's load of that kind, a second one, to a
 *   fixed URL on a reserved name in both schemes (`http://font-http.canary.invalid/…` and its `https:` twin:
 *   {@link canaryUrl}); or the reason it has neither.
 * - **How it is read: by content, never by time.** Every trusted `securitypolicyviolation` the view's document hears
 *   carries the text of the policy that raised it (`originalPolicy`) and its disposition. One whose text is not the
 *   file's own, or that only reports, is another policy's, whenever it arrives, before the announcement or after it: a
 *   finding of the kind its disposition names (POLICY_FINDINGS). The file states the `<meta>`'s text of itself
 *   ({@link POLICY_ATTRIBUTE}), as it states its version, so the view compares texts and computes no hash. A refused
 *   canary is known by its host, which names its kind and the scheme it was issued in, so a load an engine upgraded or
 *   cut to its origin still names its canary. The view announces itself once each refused kind has raised the `<meta>`'s
 *   own event in one scheme at least (a page on `https:` blocks the `http:` twin as mixed content, which no policy sees),
 *   every admitted load has settled and the canary worker has answered; a load that has not answered yet is "not yet",
 *   never "another policy". The only time limit is the host page's load timeout (LOAD_TIMEOUT_MS).
 * - **What reaches the host: names and booleans.** The announcement carries one verdict per row of POLICY_FINDINGS, true
 *   where no policy of that kind was seen; a finding after the announcement is posted on the view port (VIEW_POLICY),
 *   with the same verdicts, once. The host takes the reason from its own registry (startup-verdicts.ts, `policyFinding`).
 *
 * The worker's half of the check is the view's canary worker: a `blob:` worker inherits the policies of the document that
 * makes it, which are fixed when that document is created, so the guest's worker, made later by the same view, runs under
 * exactly the policies the canary worker ran under, and its findings come before anything of the guest's is sent. A
 * canary in the guest's worker could not answer before the entry runs: a refusal's event comes in a task, after the
 * worker's whole script.
 *
 * No canary leaves the browser under the `<meta>`: every network URL is on the reserved name `.invalid`, which resolves
 * nowhere, and the `<meta>` refuses it before a request exists (research 31, Q6). What the check does not see, and what
 * stands behind it there, is POLICY_CANARIES' `unseen` and design 03's table of the renderer's rules.
 */
import type { FixedReasonId } from './reasons';

/** The texts of the file that its policy admits by hash. */
export const HASHED_TEXTS = ['guard', 'view', 'still', 'sizing'] as const;
export type HashedText = (typeof HASHED_TEXTS)[number];

/** A source of the file's policy: `blob:`, or the hash of one of the file's own texts. */
export type PolicySource = 'blob:' | { readonly hash: HashedText };

export interface PolicyDirectiveRow {
    /** The directive's sources, in order; with none, the directive is `'none'`. */
    readonly sources: readonly PolicySource[];
    /** Why the directive has these sources. */
    readonly why: string;
}

/**
 * The file's constant policy, one row per directive, in the order of the `<meta>`'s text (design 03, "A constant
 * policy"): scripts by hash, the still stylesheet by hash, `blob:` for the four kinds of file, `worker-src blob:`,
 * `connect-src 'none'`, everything else `'none'`. No `'unsafe-inline'`, no `'unsafe-eval'`, no report directive, and no
 * input: the generator (sealed-document.ts) reads this table and the hashes of the library's own texts, nothing else.
 */
export const POLICY_DIRECTIVES = {
    'default-src': { sources: [], why: 'every fetch directive not listed here falls back to it' },
    'script-src': { sources: [{ hash: 'guard' }, { hash: 'view' }], why: "F's guard and C's bootstrap, by hash: no other script runs in F, C or a document either makes" },
    'script-src-attr': { sources: [], why: 'no event handler attribute runs' },
    'style-src': { sources: [{ hash: 'still' }, { hash: 'sizing' }, 'blob:'], why: "the still stylesheet the view inserts for `allowAnimations: false` (VIEW_STILL_STYLE), F's sizing sheet (SEALED_DOCUMENT_STYLE), and the guest's stylesheets as the blob: URLs the view mints; guest styles otherwise go through the CSSOM" },
    'img-src': { sources: ['blob:'], why: "images, from the blob: URLs the view mints for the app's files and writes" },
    'font-src': { sources: ['blob:'], why: "fonts, from the blob: URLs the view mints for the app's files" },
    'media-src': { sources: ['blob:'], why: "media, from the blob: URLs the view mints for the app's files" },
    'connect-src': { sources: [], why: 'sealed mode has no network: the worker reads its files with sandboxFiles.read(), which makes no request' },
    'worker-src': { sources: ['blob:'], why: "the guest's worker, which C starts from a blob: URL" },
    'frame-src': { sources: [], why: 'no frame of the view loads a URL (C itself is a srcdoc)' },
    'object-src': { sources: [], why: 'no plugin content' },
    'base-uri': { sources: [], why: "no <base> after the policy: F's own, about:blank, precedes it, and C inherits that base URL" },
    'form-action': { sources: [], why: 'no form submits anywhere' },
    'manifest-src': { sources: [], why: 'no manifest' },
} as const satisfies Record<string, PolicyDirectiveRow>;

export type PolicyDirective = keyof typeof POLICY_DIRECTIVES;

/** The `<meta>`'s text from the hash source of each hashed text: POLICY_DIRECTIVES, in order. */
export function policyText(hashes: Readonly<Record<HashedText, string>>): string {
    const parts: string[] = [];
    for (const [name, row] of Object.entries(POLICY_DIRECTIVES) as [PolicyDirective, PolicyDirectiveRow][]) {
        const sources: string[] = [];
        for (const source of row.sources) sources.push(typeof source === 'string' ? source : hashes[source.hash]);
        parts.push(`${name} ${sources.length === 0 ? "'none'" : sources.join(' ')}`);
    }
    return parts.join('; ');
}

/**
 * The attribute of the view document's root element that states the `<meta>`'s text, beside its version
 * (VERSION_ATTRIBUTE): outside every hashed text, written by the generator from the same value as the `<meta>`, and read
 * by the view, which compares every violation's policy text with it.
 */
export const POLICY_ATTRIBUTE = 'data-web-sandbox-policy';

/** The view's loads a policy can refuse: what each canary does, the view's table keyed by these names (in-sandbox-view.ts). */
export const ADMITTED_LOADS = ['style', 'image', 'font', 'media', 'worker'] as const;
export type AdmittedLoad = (typeof ADMITTED_LOADS)[number];
export const REFUSED_LOADS = ['script', 'style', 'image', 'font', 'media', 'connect', 'frame', 'object', 'base', 'dataWorker'] as const;
export type RefusedLoad = (typeof REFUSED_LOADS)[number];

export interface PolicyCanaryRow {
    /**
     * The load the `<meta>` admits, which a stricter policy refuses: a `blob:` URL the view minted (or its canary worker,
     * from one), read once it settled; `'bootstrap'` where it is the view's own script, which needs no canary; or null.
     */
    readonly admitted: AdmittedLoad | 'bootstrap' | null;
    /**
     * The load the `<meta>` refuses: to {@link canaryUrl} in both schemes, or (`dataWorker`) a `data:` worker, which names
     * no host of anyone's; or null.
     */
    readonly refused: RefusedLoad | null;
    /** Why the directive has no canary of a kind, where it has none. */
    readonly why?: string;
    /** What the check cannot see of this directive, and what stands behind it there. */
    readonly unseen?: string;
}

/**
 * Every directive of the file's policy and its canaries (research 31, Q3 and Q6: what each sees, on Chromium 159,
 * Firefox 159 and WebKit 27.2). Keyed by POLICY_DIRECTIVES' names, all of them: a directive added to the policy is a
 * type error here until it is classified.
 */
export const POLICY_CANARIES = {
    'default-src': {
        admitted: null, refused: null,
        why: "it governs no load of the view's: the file names every fetch directive a load of the view's is checked against. A header's `default-src` is seen through the canaries of the directives it stands for",
    },
    'script-src': {
        admitted: 'bootstrap', refused: 'script',
        why: "the admitted load is the view's own bootstrap: a policy that refuses it stops the view before it runs (`documentSilent`), and one that only reports it raises its event in the view. Code from strings is the `stringCode` gate's canary, whose events are read as every other",
    },
    'script-src-attr': {
        admitted: null, refused: null,
        why: "an event handler attribute is no load: its refusal names no URL, and the view compiles none (the renderer keeps no handler attribute)",
        unseen: 'a header that names `script-src-attr` alone: no handler of the guest\'s exists in the view for it to refuse or sample (the renderer drops every `on*` attribute)',
    },
    'style-src': { admitted: 'style', refused: 'style' },
    'img-src': { admitted: 'image', refused: 'image' },
    'font-src': {
        admitted: 'font', refused: 'font',
        unseen: "a header that names the canaries' own host (`*.canary.invalid`), on Chromium and Firefox: the view loads a font only from a `blob:` URL it minted (keepsUrl, the cut of CSS URLs), which carries nothing of the guest's",
    },
    'media-src': {
        admitted: 'media', refused: 'media',
        unseen: "a header that names the canaries' own host, on Chromium and Firefox: the view loads media only from a `blob:` URL it minted (keepsUrl)",
    },
    'connect-src': { admitted: null, refused: 'connect', why: "`'none'` admits nothing to load" },
    'worker-src': {
        admitted: 'worker', refused: 'dataWorker',
        why: 'the refused canary is a `data:` worker: a worker of a network URL fails before the policy is asked, with no request (research 31, Q6)',
    },
    'frame-src': {
        admitted: null, refused: 'frame', why: "`'none'` admits nothing to load",
        unseen: "a header that names the canaries' own host, on Chromium and Firefox: the renderer removes every nested browsing context (RENDER_REMOVED_ELEMENTS)",
    },
    'object-src': {
        admitted: null, refused: 'object', why: "`'none'` admits nothing to load",
        unseen: "a header that names the canaries' own host, on Chromium and Firefox: the renderer removes every object and embed (RENDER_REMOVED_ELEMENTS)",
    },
    'base-uri': { admitted: null, refused: 'base', why: "`'none'` admits no `<base>`; the `base` gate's `<base>` is refused too" },
    'form-action': {
        admitted: null, refused: null,
        why: "a refused form replaced the view with an error page on Chromium (research 31, Q6), so the check submits no form on any engine",
        unseen: "any `form-action` header: the renderer drops `action`, `formaction`, `method` and `target`, and the view cancels every `submit` in the capture phase, so no form of the guest's navigates",
    },
    'manifest-src': {
        admitted: null, refused: null,
        why: 'no engine fetches a manifest a framed document links, so there is no load to refuse, and none of a guest\'s to report',
    },
} as const satisfies { readonly [D in PolicyDirective]: PolicyCanaryRow };

/** The reserved name every refused canary's host is under: `.invalid` resolves nowhere (RFC 6761). */
export const CANARY_DOMAIN = 'canary.invalid';

/** The schemes each refused network canary is issued in: a header such as `font-src https: blob:` admits one of them. */
export const CANARY_SCHEMES = ['http', 'https'] as const;
export type CanaryScheme = (typeof CANARY_SCHEMES)[number];

/**
 * A refused canary's URL: one host per kind and scheme (`font-http.canary.invalid`), so an event or a report cut down
 * to the origin, or a load upgraded to `https:`, still names the canary and the scheme it was issued in.
 */
export const canaryUrl = (load: RefusedLoad, scheme: CanaryScheme): string => `${scheme}://${load.toLowerCase()}-${scheme}.${CANARY_DOMAIN}/web-sandbox-canary`;

/**
 * The admitted canaries' fixed values: nothing of them is the guest's. The image is a 1×1 PNG, the stylesheet a rule for
 * no element, the font and the media the first bytes of a file of their kind (they settle with an error, as the
 * `<meta>` admits them and they do not decode), the canary worker's source one statement.
 */
export const POLICY_CANARY_VALUES = {
    image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    style: '#web-sandbox-canary{color:rgb(1,2,3)}',
    font: 'wOF2',
    media: 'RIFF',
    worker: "'use strict';postMessage(0)",
    dataWorker: "data:text/javascript,'use strict';",
    family: 'web-sandbox-canary',
} as const;

export interface PolicyFindingRow {
    /** The disposition of the violations that make this finding: another policy's, enforced or report-only. */
    readonly disposition: 'enforce' | 'report';
    /** The header that sets such a policy. */
    readonly header: string;
    /** The reason the build ends with. */
    readonly reason: FixedReasonId;
}

/**
 * What the check finds, as the host reads it: a verdict per row, true where no policy of that kind was seen, in the order
 * the host reads them (the first that is not exactly true names the reason).
 */
export const POLICY_FINDINGS = {
    csp: { disposition: 'enforce', header: 'Content-Security-Policy', reason: 'viewCsp' },
    cspReportOnly: { disposition: 'report', header: 'Content-Security-Policy-Report-Only', reason: 'viewCspReportOnly' },
} as const satisfies Record<string, PolicyFindingRow>;

export type PolicyFinding = keyof typeof POLICY_FINDINGS;

/** The refused loads the canaries make, once each (a load of several directives' rows is one canary). */
export function refusedLoads(): RefusedLoad[] {
    const loads = new Set<RefusedLoad>();
    for (const row of Object.values(POLICY_CANARIES) as PolicyCanaryRow[]) if (row.refused !== null) loads.add(row.refused);
    return [...loads];
}

/** The admitted loads the canaries make, once each; the bootstrap is the view's own and needs none. */
export function admittedLoads(): AdmittedLoad[] {
    const loads = new Set<AdmittedLoad>();
    for (const row of Object.values(POLICY_CANARIES) as PolicyCanaryRow[]) if (row.admitted !== null && row.admitted !== 'bootstrap') loads.add(row.admitted);
    return [...loads];
}

/** A refused load as the view is given it: its URLs, each with the host that names it in an event; none for `dataWorker`. */
export interface RefusedCanary {
    readonly load: RefusedLoad;
    readonly urls: readonly { readonly url: string; readonly host: string }[];
}

/** What the view's bootstrap is given of the check (in-sandbox-view.ts, ViewOptions.policy). */
export interface PolicyCheckOptions {
    readonly attribute: string;
    readonly refused: readonly RefusedCanary[];
    readonly admitted: readonly AdmittedLoad[];
    /** POLICY_FINDINGS as [name, disposition], in order. */
    readonly findings: readonly (readonly [string, string])[];
    readonly values: typeof POLICY_CANARY_VALUES;
}

export function policyCheckOptions(): PolicyCheckOptions {
    const findings: [string, string][] = [];
    for (const [name, row] of Object.entries(POLICY_FINDINGS) as [PolicyFinding, PolicyFindingRow][]) findings.push([name, row.disposition]);
    const refused: RefusedCanary[] = [];
    for (const load of refusedLoads()) {
        const urls: { url: string; host: string }[] = [];
        for (const scheme of CANARY_SCHEMES) {
            if (load === 'dataWorker') continue;
            const url = canaryUrl(load, scheme);
            urls.push({ url, host: new URL(url).hostname });
        }
        refused.push({ load, urls });
    }
    return { attribute: POLICY_ATTRIBUTE, refused, admitted: admittedLoads(), findings, values: POLICY_CANARY_VALUES };
}
