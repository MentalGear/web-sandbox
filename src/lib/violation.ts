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

/** The detail of a 'violation' event. Guest-supplied: validated and clamped, but not trusted. */
export interface SandboxViolation {
    /** The effective directive that refused the load, e.g. 'connect-src' or 'img-src'. */
    directive: string;
    /** What was refused: a URL (possibly reduced to its origin by the browser), or 'inline', 'eval', … */
    blockedURI: string;
    /** Where the refused code ran, when the browser says (a blob: URL, about:srcdoc, …). */
    sourceFile?: string;
    lineNumber?: number;
    columnNumber?: number;
    /**
     * Strict mode only (ADR-005, A6): which document's report this is, set by the host from the port it arrived
     * on, never read from the frame. 'view': the view document, which runs no guest code, so its reports are
     * the library's own and complete up to the cap. 'logic': the worker, whose reports guest code can forge
     * or suppress like any default-mode report, and which depend on the engine (WebKit raises none in workers;
     * Firefox raises the worker's importScripts refusals in the view, so those arrive as 'view').
     */
    source?: 'view' | 'logic';
}

/**
 * Most 'violation' events one environment can produce; later reports are dropped (one warning). This
 * bounds the host work a guest can cause through this channel: dispatching an event runs embedder
 * listeners. The guest bootstrap stops forwarding at the same number, so an honest guest never sends more.
 */
export const VIOLATION_EVENT_LIMIT = 100;

const MAX_STRING = 2048;
const DIRECTIVE = /^[a-z][a-z-]{0,63}$/;

const clampString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value.slice(0, MAX_STRING) : undefined;

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
