/**
 * The environment check (S74, class B): the first statement of every bootstrap that runs inside a sandbox document
 * (the hashed view and bridge bootstrap, the cooperative guest's, worker mode's frame's) confirms that the document is
 * the one the library built. The library predicts three facts of its documents (the wrapper's inert base URL, the frames'
 * opaque origin, the srcdoc load) and requires a fourth (the document is not cross-origin isolated); the host page's policy
 * and the browser decide them. A bootstrap that finds one different stays inert: it registers nothing, runs no guest code, tells the host page (a portless refusal, below) and
 * the element ends the sandbox with the row's reason. A copy of the bootstrap anywhere else (the host page, a frame
 * the library did not build) finds the origin or the URL different and does nothing.
 *
 * One table, one function. `ENVIRONMENT_CHECKS` is the values: what each row checks, why, what the document must read,
 * and the termination reason (reasons.ts). `checkSandboxEnvironment` is stringified into the bootstraps (the gate,
 * in-sandbox-view.ts, `environmentGate`) and is given the table's expected values as one literal, in table order; the
 * first value that differs is the refusal. The values are read once, before any other statement of the bootstrap: no
 * script of the guest's has run in these documents yet.
 */
import type { FrameType } from './frames';
import type { ReasonId } from './reasons';

export interface EnvironmentCheckRow {
    /** What is checked. */
    readonly checks: string;
    /** Why the library needs it. */
    readonly why: string;
    /** What the document reads when it is the one the library built. */
    readonly expected: string;
    /** The termination reason the element gives when it does not (reasons.ts). */
    readonly reason: Extract<ReasonId, `environment${string}`>;
}

export const ENVIRONMENT_CHECKS = {
    origin: {
        checks: "the document's origin (`self.origin`, the origin of the document's settings: `location.origin` reads `'null'` in every srcdoc)",
        why: "every frame of the library's is sandboxed without `allow-same-origin`, so its origin is opaque: a document that reads another origin is not one of those frames, or runs with the host page's storage, cookies and DOM",
        expected: 'null',
        reason: 'environmentOrigin',
    },
    url: {
        checks: "the document's URL (`location.href`)",
        why: "the library writes every document as a srcdoc, which an opaque-origin frame loads at `about:srcdoc` and no navigation of the guest's replaces without a second load: a document at any other URL was not loaded as built",
        expected: 'about:srcdoc',
        reason: 'environmentUrl',
    },
    base: {
        checks: "the document's base URL (`document.baseURI`)",
        why: "the wrapper's `<base href=\"about:blank\">` (frame-documents.ts, WRAPPER_BASE) is what keeps the host page's URL out of the guest (every relative URL fails closed); a host page whose `base-uri` refuses it leaves the srcdoc the host page's own base URL, with its path, query and fragment",
        expected: 'about:blank',
        reason: 'environmentBase',
    },
    isolated: {
        checks: "whether the document is cross-origin isolated (`crossOriginIsolated`, read as `=== true`)",
        why: "a guest never runs cross-origin isolated (owner decision, 2026-10-23): isolation unlocks `SharedArrayBuffer`, precise timers and other powers the library's policies do not account for, and the host page's COOP and COEP headers are what make its frames isolated (a frame inherits the host page's COEP and an isolated top-level page's agent cluster), so a host page that sets both is not one a sandbox runs in",
        expected: 'false',
        reason: 'environmentIsolated',
    },
} as const satisfies Record<string, EnvironmentCheckRow>;

export type EnvironmentCheckId = keyof typeof ENVIRONMENT_CHECKS;

/** The values a library document reads, by row, in table order: the one literal the check is given. */
export type EnvironmentExpectation = { readonly [K in EnvironmentCheckId]: (typeof ENVIRONMENT_CHECKS)[K]['expected'] };

export const ENVIRONMENT_EXPECTED: EnvironmentExpectation = {
    origin: ENVIRONMENT_CHECKS.origin.expected,
    url: ENVIRONMENT_CHECKS.url.expected,
    base: ENVIRONMENT_CHECKS.base.expected,
    isolated: ENVIRONMENT_CHECKS.isolated.expected,
};

/**
 * The type of the portless refusal a bootstrap posts to the host page's window when its environment is not the one built
 * (the announcement channel, frames.ts). The stringified function spells the literal out (it closes over nothing); a
 * unit test keeps it equal to this constant. The element accepts it from the guest frame's window and from the fetch
 * bridge's frame, and takes the reason from its own table (host.ts), never from the message.
 */
export const ENVIRONMENT_REFUSED_TYPE = 'ENVIRONMENT_REFUSED' satisfies FrameType;

/**
 * Stringified into the bootstraps, first. Compares what the document reads with `expected`, row by row in the table's
 * order, and on the first difference stays inert: it posts the refusal to `host` (the host page's window, as the
 * bootstrap reaches it), stops the document's parser when `stopParsing` (the cooperative guest's document, where guest
 * markup follows the bootstrap) and the document reads like a frame of the library's, and returns the row's id. A
 * bootstrap that is its own host page's window (a copy in the host page) posts and stops nothing. Returns null when
 * every row holds, and the bootstrap goes on.
 */
export function checkSandboxEnvironment(expected: EnvironmentExpectation, host: Window | null, stopParsing: boolean): EnvironmentCheckId | null {
    const actual: Record<EnvironmentCheckId, string> = { origin: self.origin, url: location.href, base: document.baseURI, isolated: String(self.crossOriginIsolated === true) };
    // A document that reads the opaque origin and the srcdoc URL is a frame of the library's (or poses as one); its parser
    // is the library's to stop. Any other document is not.
    const frame = actual.origin === expected.origin && actual.url === expected.url;
    const ids = Object.keys(expected) as EnvironmentCheckId[];
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        if (actual[id] === expected[id]) continue;
        if (host && host !== window) {
            host.postMessage({ type: 'ENVIRONMENT_REFUSED', refused: id }, '*');
            if (stopParsing && frame) window.stop();
        }
        return id;
    }
    return null;
}
