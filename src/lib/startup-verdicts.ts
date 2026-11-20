/**
 * What the host page reads of the view's announcement and of the worker's verdicts (design 03, "The start-up order"):
 * the version the view states and each gate's verdict, read by the host's own registries, and nothing else. Each
 * answers the reason the build ends with, or null for one that may go on. Pure: host.ts reads the message, and the
 * lifecycle reducer acts on the answer (`viewAnnounced`, `workerVerdicts`).
 *
 * - **The version** (document-digest.ts): a served view states the digest of the file it was generated as. One that
 *   states another, or none, is another version's file, and receives no port (`documentVersion`). Strict mode's view is
 *   the `srcdoc` document this very element writes, so it is of this version by construction and states none.
 * - **The verdicts** (startup-gates.ts): for each gate the registry gives the realm in the build's mode, in the
 *   registry's order, the verdict must be exactly `true`; the first that is not (false, missing, or not a boolean) ends
 *   the build with that gate's reason. A name the registry does not give is not read.
 */
import { gatesOf, STARTUP_GATES, type GateMode, type GateRealm, type GateRow } from './startup-gates';
import { reasonText } from './reasons';

const hasOwn = (value: object, name: string) => Object.prototype.hasOwnProperty.call(value, name);
const GATES: Readonly<Record<string, GateRow>> = STARTUP_GATES;

/** The reason of the first gate of `realm` in `mode` whose verdict in `verdicts` is not `true`, or null when all held. */
export function verdictFinding(verdicts: unknown, realm: GateRealm, mode: GateMode): string | null {
    const given = typeof verdicts === 'object' && verdicts !== null ? verdicts : {};
    for (const name of gatesOf(realm, mode)) {
        const held = hasOwn(given, name) && (given as Record<string, unknown>)[name] === true;
        if (!held) return reasonText(GATES[name]!.reason);
    }
    return null;
}

/**
 * The view's announcement, `data` as it arrived from the first frame of the element's frame: for a served view
 * (`expectedVersion`, the digest this library was built with), the version first, then the view's verdicts; for strict
 * mode's view (null), the verdicts alone.
 */
export function announcementFinding(data: { readonly version?: unknown; readonly verdicts?: unknown }, mode: GateMode, expectedVersion: string | null): string | null {
    if (expectedVersion !== null && data.version !== expectedVersion) return reasonText('documentVersion');
    return verdictFinding(data.verdicts, 'view', mode);
}
