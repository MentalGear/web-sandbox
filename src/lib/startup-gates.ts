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
    /**
     * The directive whose `securitypolicyviolation` its refused canary raises, or null for none. The realm takes one such
     * event per gate, before its own reports' listener, so a canary of the library's is never reported to the embedder as
     * a violation of the guest's.
     */
    readonly raises: string | null;
}

// Why a gate that provokes a policy runs in sealed mode only.
const PROVOKES_A_POLICY = "it provokes a refusal of the view's policy: strict mode's view inherits the host page's policy, which would report the canary to the host page's endpoint, and admits what the embedder's network options name";

/**
 * Every gate, in the order the host reads them: the first that failed names the reason. Research 28 (Q7) measured
 * twelve canaries and research 31 (Q2) ran them in the view and the worker of this design; the frame canary is left out
 * (design 03, "The start-up gates": it is blind to its own directive while `script-src` holds, and cost 1.6 s).
 */
export const STARTUP_GATES = {
    opaque: {
        realms: ['worker'], modes: ['sealed', 'strict'],
        provokes: "reads the worker's `self.origin` (the view's own is the environment check's, environment-check.ts, the `origin` row: it runs first, and ends the build with `environmentOrigin`)",
        pass: "`'null'`: the worker has an opaque origin",
        fail: "an origin: the worker holds an origin's authority",
        reason: 'gateOpaque', raises: null,
        mutant: "none through the element alone: a view that is not opaque (its `sandbox` attribute with `allow-same-origin`, in a copy without its guard, framed without `sandbox`) is refused by the environment check before it starts a worker; test/unit/startup-gates.test.ts runs the canary",
    },
    framing: {
        realms: ['view'], modes: ['sealed', 'strict'],
        provokes: "compares the view's window with its parent and its parent's parent",
        pass: 'all three differ: the view is a frame of a frame, as the file or the wrapper holds it',
        fail: 'the view is the top-level document, or its frame is',
        reason: 'gateFraming', raises: null,
        mutant: 'none through the element, which always frames the file: a file opened at the top level without its guard has no host page to announce itself to; test/unit/startup-gates.test.ts runs the view top-level, where it fails',
    },
    stringCode: {
        realms: ['view', 'worker'], modes: ['sealed'], modesWhy: PROVOKES_A_POLICY,
        provokes: "builds a function from the empty string (`new Function('')`)",
        pass: 'it throws: the policy runs no code from strings',
        fail: 'the function is built',
        reason: 'gateStringCode', raises: 'script-src',
        mutant: "`'unsafe-eval'` in `script-src`; no `<meta>`",
    },
    connect: {
        realms: ['view'], modes: ['sealed'], modesWhy: PROVOKES_A_POLICY,
        provokes: "requests a `blob:` URL of the view's own with `fetch` (the worker has no name that makes a request: the allowlist took them, and `allowlist` confirms it)",
        pass: 'the request is refused, before it leaves the realm',
        fail: 'the request is answered',
        reason: 'gateConnect', raises: 'connect-src',
        mutant: '`connect-src * data: blob:`; no `<meta>`',
    },
    image: {
        realms: ['view'], modes: ['sealed'], modesWhy: PROVOKES_A_POLICY,
        provokes: 'loads a `data:` image (an empty SVG)',
        pass: "the image's `error` event",
        fail: 'its `load` event',
        reason: 'gateImage', raises: 'img-src',
        mutant: '`img-src * data: blob:`; no `<meta>`',
    },
    style: {
        realms: ['view'], modes: ['sealed'], modesWhy: PROVOKES_A_POLICY,
        provokes: 'inserts a `<style>` of a text the policy does not admit by hash, for an element of its own',
        pass: "the element's computed colour is not the sheet's",
        fail: "it is the sheet's",
        reason: 'gateStyle', raises: 'style-src',
        mutant: "`style-src 'unsafe-inline' blob:`; no `<meta>`",
    },
    base: {
        realms: ['view'], modes: ['sealed'], modesWhy: PROVOKES_A_POLICY,
        provokes: 'inserts a `<base href="http://gate.invalid/">` (a reserved name: nothing is requested)',
        pass: "the document's base URL is unchanged",
        fail: 'it is the canary\'s',
        reason: 'gateBase', raises: 'base-uri',
        mutant: '`base-uri *`; no `<meta>`',
    },
    cookie: {
        realms: ['view'], modes: ['sealed', 'strict'],
        provokes: 'writes a cookie of a fixed name, for 5 seconds',
        pass: 'the write throws, or the cookie is not kept',
        fail: 'it is kept',
        reason: 'gateCookie', raises: null,
        mutant: "none through the element: the environment check refuses a view that is not opaque first (`opaque`); test/unit/startup-gates.test.ts runs the canary",
    },
    storage: {
        realms: ['view', 'worker'], modes: ['sealed', 'strict'],
        provokes: '`localStorage` in the view, `indexedDB.open` in the worker',
        pass: 'it throws',
        fail: 'a store opens',
        reason: 'gateStorage', raises: null,
        mutant: "none through the element: the environment check refuses a view that is not opaque first (`opaque`); test/unit/startup-gates.test.ts runs the canary",
    },
    parent: {
        realms: ['view'], modes: ['sealed', 'strict'],
        provokes: "reads its parent's document",
        pass: 'the read throws: the parent is of another origin',
        fail: "the parent's document is read",
        reason: 'gateParent', raises: null,
        mutant: "none through the element: the environment check refuses a view that is not opaque first (`opaque`); test/unit/startup-gates.test.ts runs the canary",
    },
    allowlist: {
        realms: ['worker'], modes: ['sealed', 'strict'],
        provokes: "reads, right after the globals allowlist, every name of the worker's global and of its prototypes (what the allowlist prunes)",
        pass: "each is a name of the allowlist (sealed mode's has none that makes a request: no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `importScripts`), a prototype's `constructor`, or a constant",
        fail: 'a name off the allowlist is still there',
        reason: 'gateAllowlist', raises: null,
        mutant: "a name off the allowlist given back between the allowlist and this gate (the worker's source with `fetch` put back)",
    },
} as const satisfies Record<string, GateRow>;

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
 * The view's canaries' fixed values: nothing of them is the guest's, and none names a host that answers. The image is an
 * empty SVG as a `data:` URL; the stylesheet is not admitted by any hash of the file's policy and colours its own target;
 * the base URL is on a reserved name (`.invalid`), and a `<base>` requests nothing.
 */
export const GATE_CANARIES = {
    gateImage: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221%22%20height%3D%221%22%2F%3E',
    gateStyle: '#web-sandbox-gate{color:rgb(9,9,9)}',
    gateStyleTarget: 'web-sandbox-gate',
    gateStyleColor: 'rgb(9, 9, 9)',
    gateBase: 'http://gate.invalid/',
    gateCookie: 'web-sandbox-gate',
} as const;

/** The directive each gate's refused canary raises a violation of (`raises`), for the gates of `among` that raise one. */
export function gateViolations(among: readonly GateName[] = Object.keys(STARTUP_GATES) as GateName[]): Readonly<Record<string, string>> {
    const raised: Record<string, string> = {};
    for (const name of among) {
        const row: GateRow = STARTUP_GATES[name];
        if (row.raises !== null) raised[name] = row.raises;
    }
    return raised;
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
export function workerGates(g: any, names: readonly string[], raises: Readonly<Record<string, string>>, allowed: readonly string[]): () => void {
    const apply = Reflect.apply;
    const O = ({}).constructor as ObjectConstructor;
    const post = g.postMessage;
    const listen = g.addEventListener;
    const unlisten = g.removeEventListener;
    const objectPrototype = O.prototype;
    const descriptorOf = O.getOwnPropertyDescriptor;
    const has = objectPrototype.hasOwnProperty;
    const prototypeOf = O.getPrototypeOf;
    // The getter of a violation's directive, captured now where the worker names the event's class. Firefox's worker
    // fires the event without naming the class: there it is read from the first event's own prototype, which no guest
    // code can have reached before (the canary's event is queued before any of the guest's, and this listener is the
    // first on the global), and the listener leaves after its one event.
    const violationClass = g.SecurityPolicyViolationEvent;
    let directiveOf: (() => unknown) | null = violationClass ? descriptorOf(violationClass.prototype, 'effectiveDirective')!.get! : null;
    const stopImmediate = g.Event.prototype.stopImmediatePropagation;
    const startsWith = String.prototype.startsWith;
    const count = names.length;
    const verdicts: Record<string, boolean> = {};
    // The violations the canaries raise, one per gate that raises one (`raises`): taken here, ahead of the bootstrap's
    // own reports' listener, which the worker's source installs later, so none is reported as the guest's. The events
    // come in tasks, after the worker's script, the entry included, has run: so this listener reads them through
    // getters captured now, and removes itself once it took them all.
    const expected: string[] = [];
    let wanted = 0;
    for (let i = 0; i < count; i++) {
        const name = names[i]!;
        if (apply(has, raises, [name])) expected[wanted++] = raises[name]!;
    }
    let left = wanted;
    const take = (event: Event) => {
        if (directiveOf === null) {
            const found = descriptorOf(prototypeOf(event), 'effectiveDirective');
            directiveOf = found && found.get ? found.get : () => '';
        }
        const directive = String(apply(directiveOf, event, []));
        for (let i = 0; i < wanted; i++) {
            const want = expected[i]!;
            if (want === '' || !apply(startsWith, directive, [want])) continue;
            expected[i] = ''; // taken
            left--;
            apply(stopImmediate, event, []);
            if (left === 0) apply(unlisten, g, ['securitypolicyviolation', take, true]);
            return;
        }
    };
    if (left > 0) apply(listen, g, ['securitypolicyviolation', take, true]);
    // A non-configurable primitive (a WebIDL constant) is what the allowlist leaves too: it cannot be deleted, and makes
    // no request (worker-globals.ts, keepOnlyWorkerGlobals).
    const isConstant = (descriptor: PropertyDescriptor | undefined) => {
        if (!descriptor || !('value' in descriptor)) return false;
        const value: unknown = descriptor.value;
        return value === null || (typeof value !== 'object' && typeof value !== 'function');
    };
    // The canaries that need the worker's own names, before the allowlist removes them.
    const before: Record<string, () => boolean> = {
        opaque: () => String(g.origin) === 'null',
        stringCode: () => {
            try {
                new g.Function('');
                return false;
            } catch {
                return true;
            }
        },
        storage: () => {
            try {
                g.indexedDB.open('web-sandbox-gate');
                return false;
            } catch {
                return true;
            }
        },
    };
    // What the allowlist must have left: the names it keeps and nothing else, on the global and its prototypes, as it
    // prunes them.
    const after: Record<string, () => boolean> = {
        allowlist: () => {
            const eventTargetClass = g.EventTarget;
            const eventTarget = eventTargetClass ? eventTargetClass.prototype : null;
            for (let scope: object | null = g; scope && scope !== eventTarget && scope !== objectPrototype; scope = prototypeOf(scope)) {
                const own = O.getOwnPropertyNames(scope);
                for (let i = 0; i < own.length; i++) {
                    const name = own[i]!;
                    if (allowed.includes(name) || (name === 'constructor' && scope !== g)) continue;
                    if (!isConstant(descriptorOf(scope, name))) return false;
                }
            }
            return true;
        },
    };
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
