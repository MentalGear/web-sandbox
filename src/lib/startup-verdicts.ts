/**
 * What the host page reads of the view's announcement and of the worker's verdicts (design 03, "The start-up order"):
 * the version the view states, each gate's verdict and the policy check's, read by the host's own registries, and
 * nothing else. Each answers the reason the build ends with, or null for one that may go on. Pure: host.ts reads the
 * message, and the lifecycle reducer acts on the answer (`viewAnnounced`, `workerVerdicts`).
 *
 * - **The version** (document-digest.ts): a served view states the digest of the file it was generated as. One that
 *   states another, or none, is another version's file, and receives no port (`documentVersion`). Strict mode's view is
 *   the `srcdoc` document this very element writes, so it is of this version by construction and states none.
 * - **The verdicts** (startup-gates.ts): for each gate the registry gives the realm in the build's mode, in the
 *   registry's order, the verdict must be exactly `true`; the first that is not (false, missing, or not a boolean) ends
 *   the build with that gate's reason. A name the registry does not give is not read.
 * - **The policy check** (policy-check.ts, POLICY_FINDINGS): the served view's, after its gates, read the same way, in
 *   its announcement and in a later VIEW_POLICY.
 */
import { gatesOf, STARTUP_GATES, type GateMode, type GateRealm, type GateRow } from './startup-gates';
import { POLICY_FINDINGS, type PolicyFindingRow } from './policy-check';
import { reasonText, type FixedReasonId } from './reasons';

const hasOwn = (value: object, name: string) => Object.prototype.hasOwnProperty.call(value, name);
const GATES: Readonly<Record<string, GateRow>> = STARTUP_GATES;
const FINDINGS: Readonly<Record<string, PolicyFindingRow>> = POLICY_FINDINGS;

/** The reason of the first of `names` whose verdict in `verdicts` is not exactly `true`, or null when all held. */
function firstFailed(verdicts: unknown, names: readonly string[], reasonOf: (name: string) => FixedReasonId): string | null {
    const given = typeof verdicts === 'object' && verdicts !== null ? verdicts : {};
    for (const name of names) {
        const held = hasOwn(given, name) && (given as Record<string, unknown>)[name] === true;
        if (!held) return reasonText(reasonOf(name));
    }
    return null;
}

/** The reason of the first gate of `realm` in `mode` whose verdict in `verdicts` is not `true`, or null when all held. */
export function verdictFinding(verdicts: unknown, realm: GateRealm, mode: GateMode): string | null {
    return firstFailed(verdicts, gatesOf(realm, mode), name => GATES[name]!.reason);
}

/** The reason of the policy check's first finding in `policy` (VIEW_ANNOUNCE's or VIEW_POLICY's), or null for none. */
export function policyFinding(policy: unknown): string | null {
    return firstFailed(policy, Object.keys(POLICY_FINDINGS), name => FINDINGS[name]!.reason);
}

/**
 * The view's announcement, `data` as it arrived from the first frame of the element's frame: for a served view
 * (`expectedVersion`, the digest this library was built with), the version first, then the view's verdicts, then the
 * policy check's; for strict mode's view (null), the verdicts alone.
 */
export function announcementFinding(data: { readonly version?: unknown; readonly verdicts?: unknown; readonly policy?: unknown }, mode: GateMode, expectedVersion: string | null): string | null {
    if (expectedVersion !== null && data.version !== expectedVersion) return reasonText('documentVersion');
    const gate = verdictFinding(data.verdicts, 'view', mode);
    if (gate !== null || expectedVersion === null) return gate;
    return policyFinding(data.policy);
}
