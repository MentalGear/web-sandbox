/**
 * The errors the library makes (BD6:LIM-1; class P, what crosses is what the API shows). Each is made with a fixed text
 * of the library's own, never an engine's, so a host method that lets one propagate to the guest (`await el.call(…)`
 * with no catch) hands the guest that text and nothing else; its `cause`, where an engine's error is kept, never
 * crosses. The registry is module state of the host realm: the broker of every element, `fileError` and `fetchRefusal`
 * add to it, and the host's broker asks it (rpc.ts, `isMinted`). The guest's broker has none.
 */
const minted = new WeakSet<object>();

/** Registers `error` as made by the library, and returns it. */
export function markMinted<T extends Error>(error: T): T {
    minted.add(error);
    return error;
}

/** Whether `error` was registered by {@link markMinted}. Never throws, whatever the value. */
export function isMinted(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    return minted.has(error);
}
