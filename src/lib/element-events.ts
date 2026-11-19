/**
 * The element's events (class D/L, docs/research/18_finding_classes/README.md; R5:L-3): every event the
 * element dispatches is made here, by one constructor, from one table of the types, whether each bubbles and whether it
 * carries guest data. The
 * constructor freezes the detail deeply, so the first listener cannot change what a later listener reads: every detail is
 * one state seen by every listener, never a copy one of them rewrote.
 *
 * Why one constructor: docs/API.md says "Every detail is frozen", and a detail left unfrozen at one dispatch site would
 * let a listener rewrite `reason` for every listener after it. A rule kept at each site
 * is a rule some site forgets; test/unit/element-events.test.ts fails on any `new CustomEvent` outside this module and on
 * any dispatch in host.ts that does not use elementEvent().
 *
 * Deeply: the detail, and every plain object, array, Map and Set inside it (a guest's log line holds its own structured
 * clones). What cannot be frozen stays as it is: the bytes of a typed array or an ArrayBuffer, the entries of a Map or a
 * Set, a Date's time (docs/API.md, Events). The walk visits each object once, so a cycle ends it, and it is bounded by what
 * a detail can hold: a log line measures at most LOG_MAX_BYTES on receipt, before it is dispatched. What it costs is the
 * one new cost on the host page's thread here, so it is measured (test/unit/element-events.test.ts, V8): the line with the
 * most objects a guest can send, about 30 000 empty objects within LOG_MAX_BYTES, freezes in 8–12 ms, half of what the
 * element's own measure of that line on receipt already takes; the guest's relay sends at most 4 MiB of lines a second,
 * so at most four such lines.
 *
 * Host-side only, never stringified into the guest, so it may use module scope freely.
 */

/**
 * Every event the element dispatches (docs/API.md, Events): whether it bubbles, whether its detail carries data the
 * guest chose (`guestData`), and the builds that dispatch it. An event that carries guest data does not bubble (design
 * 01, I5): a listener on an ancestor receives it only if it was added for the capture phase, so a bubbling listener on a
 * shared ancestor never mixes one app's data with another's. test/unit/element-events.test.ts holds the table to it.
 *
 * - `sandbox-log`: the guest's console lines and errors (the element's own lines ride it too);
 * - `violation`: what the guest's realm or its view reports, a claim of the guest's;
 * - `fileswritten`: the path the guest wrote;
 * - `fileschanged`: the paths a commit changed, which the guest's writes named;
 * - `fetch`: the URL the guest asked for. The network build's only.
 * `ready` carries nothing, and `terminated` the library's reason or the embedder's own.
 *
 * The table's type holds the rule: a row with `guestData: true` and `bubbles: true` does not compile.
 */
type ElementEventBuilds = { readonly builds: 'every' | 'network' };
type GuestDataEvent = ElementEventBuilds & { readonly guestData: true; readonly bubbles: false };
type LibraryDataEvent = ElementEventBuilds & { readonly guestData: false; readonly bubbles: boolean };
type ElementEventRow = GuestDataEvent | LibraryDataEvent;

export const ELEMENT_EVENTS = Object.freeze({
    'ready': { bubbles: false, guestData: false, builds: 'every' },
    'terminated': { bubbles: false, guestData: false, builds: 'every' },
    'sandbox-log': { bubbles: false, guestData: true, builds: 'every' },
    'violation': { bubbles: false, guestData: true, builds: 'every' },
    'fetch': { bubbles: false, guestData: true, builds: 'network' },
    'fileschanged': { bubbles: false, guestData: true, builds: 'every' },
    'fileswritten': { bubbles: false, guestData: true, builds: 'every' },
} as const satisfies Readonly<Record<string, ElementEventRow>>);

export type ElementEventType = keyof typeof ELEMENT_EVENTS;

/**
 * `value` frozen, with every object reachable from it that can be (above); returns `value`. A detail is the library's
 * own object or a structured clone (a guest's log arguments), so every property is a data property: its values are read
 * with Object.values, which runs no getter on such an object. The walk follows own keys, an array's included, never its
 * `length`: a sparse array of 2**32 - 1 slots holds as many members as it has keys, the count the byte measure charged
 * (structured-size.ts, S77).
 */
export function freezeDeep<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    const seen = new Set<object>();
    const pending: object[] = [value as object];
    const keep = (member: unknown) => {
        if (member !== null && typeof member === 'object') pending.push(member);
    };
    while (pending.length > 0) {
        const object = pending.pop()!;
        if (seen.has(object)) continue;
        seen.add(object);
        // a typed array's or a DataView's bytes cannot be frozen (Object.freeze throws on a non-empty one), nor read here
        if (ArrayBuffer.isView(object)) continue;
        if (object instanceof Map) {
            object.forEach((member, key) => {
                keep(key);
                keep(member);
            });
        } else if (object instanceof Set) {
            object.forEach(keep);
        } else {
            const members = Object.values(object);
            for (let i = 0; i < members.length; i++) keep(members[i]);
        }
        Object.freeze(object);
    }
    return value;
}

/** The one constructor of the element's events: `type` with its bubbling from ELEMENT_EVENTS, its detail frozen deeply. None is `composed`. */
export function elementEvent(type: ElementEventType, detail: unknown = null): CustomEvent {
    return new CustomEvent(type, { detail: freezeDeep(detail), bubbles: ELEMENT_EVENTS[type].bubbles });
}
