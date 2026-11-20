/**
 * The start-up gates (design 03, "The start-up gates"; I15): canaries that confirm the browser enforces what the design
 * assumes, run by the view before it announces itself and by the worker's prelude before the guest's entry runs. One
 * registry, `STARTUP_GATES`, with a row per gate: where it runs, in which modes, what it provokes, what a pass and a fail
 * look like, and the reason a fail ends the build with. The view's and the worker's code run the gates the registry
 * gives them (`gatesOf`), and the host reads their verdicts by it (startup-verdicts.ts); the docs and the tests are
 * derived from it.
 *
 * The gates are defence in depth after the construction, never in place of it: the file's policy, the view's `sandbox`
 * attribute and the worker's allowlist are constants of the library's own code, and the gates answer only "the browser
 * has a bug or a setting that dissolves them", for the cases a canary can provoke.
 *
 * A verdict is a gate's name and whether it held, nothing else: the view and the worker compose no text, and the host
 * takes each reason from its own registry by the name (reasons.ts). A document that forges its verdicts can only end
 * its own build.
 */
import type { FixedReasonId } from './reasons';

/** Where a gate runs: the view's document, before it announces itself, or the guest's worker, before the entry. */
export type GateRealm = 'view' | 'worker';

/**
 * The modes whose builds run a gate. Sealed mode's view is the served file, whose policy is the file's own; strict
 * mode's view is a `srcdoc` document of the host page's, which inherits the host page's policy and reports what it
 * refuses to the host page's endpoint, so a gate that provokes a policy runs in sealed mode only.
 */
export type GateMode = 'sealed' | 'strict';

export interface GateRow {
    readonly realms: readonly GateRealm[];
    readonly modes: readonly GateMode[];
    /** What the canary does. */
    readonly provokes: string;
    /** What the canary sees when the browser enforces the guarantee. */
    readonly pass: string;
    /** What it sees when the browser does not. */
    readonly fail: string;
    /** The reason the build ends with when the gate fails. */
    readonly reason: FixedReasonId;
    /** The mutant that provokes the failure (research 31, Q2), or why none can through the element. */
    readonly mutant: string;
    /** Why the gate runs in the modes it runs in, where it does not run in both. */
    readonly modesWhy?: string;
}

/** Every gate, in the order the host reads them: the first that failed names the reason. */
export const STARTUP_GATES = {} as const satisfies Record<string, GateRow>;

export type GateName = keyof typeof STARTUP_GATES;

/** The gates `realm` runs in a build of `mode`, in the registry's order. */
export function gatesOf(realm: GateRealm, mode: GateMode): GateName[] {
    const names: GateName[] = [];
    for (const [name, row] of Object.entries(STARTUP_GATES) as [GateName, GateRow][]) {
        if (row.realms.includes(realm) && row.modes.includes(mode)) names.push(name);
    }
    return names;
}

/** The gates each realm runs, per mode: what the view's and the worker's code are given (in-sandbox-view.ts, host.ts). */
export function gateNames(realm: GateRealm): { readonly sealed: readonly GateName[]; readonly strict: readonly GateName[] } {
    return { sealed: gatesOf(realm, 'sealed'), strict: gatesOf(realm, 'strict') };
}

/**
 * The worker's gates (stringified into the worker's prelude: host.ts, _getStrictWorkerSource), in two calls around the
 * globals allowlist. This call, before the allowlist and before anything else of the worker's source, runs the canaries
 * that need the worker's own names; the function it answers, called once the allowlist has run, runs the gates that
 * check what the allowlist left, posts every verdict to the view (`WORKER_VERDICTS`, the worker's first message, before
 * any guest code exists), and throws where a gate failed, so nothing after it in the worker's script runs: not the rest
 * of the prelude, not the entry. That throw is cancelled in the worker, so the view hears no entry error, only the
 * verdicts.
 */
export function workerGates(g: any, names: readonly string[]): () => void {
    const apply = Reflect.apply;
    const post = g.postMessage;
    const listen = g.addEventListener;
    const has = Object.prototype.hasOwnProperty;
    const count = names.length;
    const verdicts: Record<string, boolean> = {};
    const before: Record<string, () => boolean> = {};
    const after: Record<string, () => boolean> = {};
    const run = (canaries: Record<string, () => boolean>) => {
        for (let i = 0; i < count; i++) {
            const name = names[i]!;
            if (!apply(has, canaries, [name])) continue;
            try {
                verdicts[name] = canaries[name]!() === true;
            } catch {
                verdicts[name] = false;
            }
        }
    };
    run(before);
    return () => {
        run(after);
        let held = true;
        for (let i = 0; i < count; i++) {
            const name = names[i]!;
            if (verdicts[name] === true) continue;
            verdicts[name] = false;
            held = false;
        }
        apply(post, g, [{ type: 'WORKER_VERDICTS', verdicts }]);
        if (held) return;
        apply(listen, g, ['error', (event: Event) => event.preventDefault()]);
        throw new Error('[Sandbox] a start-up gate of the worker failed');
    };
}
