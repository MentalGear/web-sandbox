/**
 * CSP violation reports from the guest (backlog S5).
 *
 * The guest bootstrap (in-sandbox-script.ts) listens for securitypolicyviolation before any guest code
 * runs and forwards each one over the port as a VIOLATION frame; the host turns it into a 'violation'
 * event on the element. A <meta> policy cannot use report-uri / report-to (S7), so this is the only
 * reporting route.
 *
 * What a report is worth: every field comes from the guest's realm, and guest code can reach the port
 * (for example by patching MessagePort.prototype.postMessage before the bootstrap next posts), so a report
 * is a claim by the guest, never a host fact. A report is evidence that the guest attempted something the
 * policy refused; the absence of reports proves nothing, since guest code can suppress its own (and a
 * frame the guest creates reports to itself, not here). Hence the detail is minimal, every field is
 * validated and clamped here, and the number of events per environment is capped.
 */

/**
 * The `detail` of a `violation` event: the guest's policy refused a load. Guest-supplied: validated and clamped, but not
 * trusted.
 *
 * @remarks
 * A report is evidence that the guest attempted something the policy refused, never a host fact: guest code can suppress
 * its own reports, a frame the guest creates reports to itself, and worker reports depend on the engine (WebKit raises
 * none in workers). At most {@link VIOLATION_EVENT_LIMIT} events per environment; in strict mode per `source`, and for the
 * view per directive, so refused loads of one kind never hide a report of another. See ADR-005.
 */
export interface SandboxViolation {
    /** The effective directive that refused the load, e.g. `'connect-src'` or `'img-src'`. */
    directive: string;
    /**
     * What was refused: a URL (possibly reduced to its origin by the browser; a `data:` or `blob:` URL is reported by its
     * scheme alone), or `'inline'`, `'eval'` and the like. At most 2048 characters.
     */
    blockedURI: string;
    /** Where the refused code ran, when the browser says (a `blob:` URL, `about:srcdoc` and the like). At most 2048 characters. */
    sourceFile?: string;
    /** The line of the refused code, a positive integer, when the browser gives one. */
    lineNumber?: number;
    /** The column of the refused code, a positive integer, when the browser gives one. */
    columnNumber?: number;
    /**
     * Strict mode only (ADR-005): which document's report this is, set by the element from the port it arrived on, never
     * read from the report. `'view'` is the view document, which runs no guest code, so its reports are the library's own
     * and complete up to the cap. `'logic'` is the worker, whose reports guest code can forge or suppress like any
     * cooperative-mode report, and which depend on the engine (WebKit raises none in workers; Firefox raises the worker's
     * `importScripts()` refusals in the view, so those arrive as `'view'`).
     */
    source?: 'view' | 'logic';
}

/**
 * Most `violation` events one environment can produce; later reports are dropped, with one warning. It bounds the host
 * work a guest can cause through this channel, since dispatching an event runs embedder listeners. In strict mode it applies
 * per `source`, and for the view per directive. The guest bootstrap stops forwarding at the same number.
 */
export const VIOLATION_EVENT_LIMIT = 100;

/**
 * The directive names a browser's report can carry as the effective directive (CSP Level 3 fetch, document and
 * navigation directives): the strict view counts its reports per name in this list, plus one count for every other
 * name (host.ts, _dispatchViolation), so its events are bounded whatever names arrive.
 */
export const VIOLATION_DIRECTIVES: readonly string[] = [
    'default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem', 'style-src-attr',
    'img-src', 'font-src', 'connect-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src',
    'manifest-src', 'base-uri', 'form-action', 'frame-ancestors',
];

/** Longest string of a report the host keeps (blockedURI, sourceFile); a longer one is cut on receipt. */
export const VIOLATION_MAX_STRING = 2048;
const DIRECTIVE = /^[a-z][a-z-]{0,63}$/;

const clampString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value.slice(0, VIOLATION_MAX_STRING) : undefined;

const positiveInteger = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/**
 * Validates one VIOLATION frame from the port and returns the event detail, or null to drop it: a frame
 * without a well-formed directive name or a string blockedURI is not a report. Only the fields named in
 * SandboxViolation are read; anything else on the frame is ignored.
 */
export function toViolationDetail(frame: unknown, source?: 'view' | 'logic'): SandboxViolation | null {
    if (!frame || typeof frame !== 'object') return null;
    const data = frame as Record<string, unknown>;

    const directive = data.directive;
    if (typeof directive !== 'string' || !DIRECTIVE.test(directive)) return null;
    const blockedURI = clampString(data.blockedURI);
    if (blockedURI === undefined) return null;

    const detail: SandboxViolation = { directive, blockedURI };
    const sourceFile = clampString(data.sourceFile);
    if (sourceFile) detail.sourceFile = sourceFile;
    const lineNumber = positiveInteger(data.lineNumber);
    if (lineNumber !== undefined) detail.lineNumber = lineNumber;
    const columnNumber = positiveInteger(data.columnNumber);
    if (columnNumber !== undefined) detail.columnNumber = columnNumber;
    if (source === 'view' || source === 'logic') detail.source = source;

    return Object.freeze(detail);
}
