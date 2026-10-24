import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECOY_HOST, DECOY_PORT, DECOY_URL, forgetHostPolicies, hostPolicyReaderLeft, hostPolicyReadFailed, knownHostPolicies, READ_FRAMES, READ_TIMEOUT_MS, SETTLE_MS, whenHostPoliciesKnown } from '@src/lib/host-csp';

/**
 * The read of the host page's policy (src/lib/host-csp.ts), against a frame that behaves as a browser's does: jsdom has no
 * frame that can fetch, so a frame is stood in for here (a window with a `fetch` that reports what the page's policy
 * would, a document that takes the events), and the real engines are the e2e specs' (test/e2e/connect-uniform.spec.ts,
 * test/e2e/host-policy-read-race.spec.ts).
 */

interface FakeFrame { window: { fetch: (url: string, init?: unknown) => Promise<unknown> } | null; document: EventTarget | null; loads: boolean }

/** Makes the next iframe the module creates a fake one: what its window's fetch does decides what the "page" reports. */
function standIn(decoy: (url: string, document: EventTarget) => void, options: Partial<FakeFrame> = {}) {
    const requested: string[] = [];
    const document = new EventTarget();
    const fake: FakeFrame = { window: { fetch: (url) => { requested.push(url); decoy(url, document); return Promise.reject(new TypeError('Failed to fetch')); } }, document, loads: true, ...options };
    const create = globalThis.document.createElement.bind(globalThis.document);
    const spy = vi.spyOn(globalThis.document, 'createElement').mockImplementation(((tag: string) => {
        const element = create(tag);
        if (tag !== 'iframe') return element;
        Object.defineProperty(element, 'contentWindow', { get: () => (element.isConnected ? fake.window : null) });
        Object.defineProperty(element, 'contentDocument', { get: () => (element.isConnected ? fake.document : null) });
        const append = (parent: Node) => {
            if (fake.loads) setTimeout(() => element.dispatchEvent(new Event('load')), 0);
            return parent;
        };
        const original = element.addEventListener.bind(element);
        element.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
            if (type === 'load' && !fake.loads) return; // jsdom would load an empty frame itself; this one never does
            original(type, listener, options);
            if (type === 'load') append(element);
        }) as typeof element.addEventListener;
        return element;
    }) as typeof globalThis.document.createElement);
    return { requested, document, fake, spy };
}

const violation = (document: EventTarget, init: { disposition: string; originalPolicy: unknown }) => {
    const event = new Event('securitypolicyviolation');
    Object.assign(event, init);
    document.dispatchEvent(event);
};

let parent: HTMLElement;
beforeEach(() => {
    forgetHostPolicies();
    parent = document.createElement('div');
    document.body.appendChild(parent);
});
afterEach(() => {
    forgetHostPolicies();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe('the read of the host page\'s policy', () => {
    it('where no frame can fetch (jsdom), the policy is unknown at once, nothing waits, and the answer is kept', () => {
        expect(knownHostPolicies()).toBeUndefined();
        expect(whenHostPoliciesKnown(parent)).toBeNull();
        expect(knownHostPolicies()).toBeNull();
        expect(hostPolicyReadFailed()).toBe(false);
        expect(parent.querySelector('iframe'), 'the frame is gone').toBeNull();
        expect(whenHostPoliciesKnown(parent)).toBeNull();
    });

    it('a parent that is not in a document gives no answer and caches none', () => {
        const detached = document.createElement('div');
        expect(whenHostPoliciesKnown(detached)).toBeNull();
        expect(knownHostPolicies()).toBeUndefined();
    });

    it('fires one http decoy at a name that cannot exist, on port 6000, from a hidden frame that holds no script, and collects the texts of the policies that refused', async () => {
        const { requested } = standIn((_, document) => {
            violation(document, { disposition: 'enforce', originalPolicy: "connect-src 'self'" });
            violation(document, { disposition: 'enforce', originalPolicy: 'connect-src https:' });
        });
        const gate = whenHostPoliciesKnown(parent);
        expect(gate).not.toBeNull();
        expect(knownHostPolicies(), 'not known while it runs').toBeUndefined();
        const frame = parent.querySelector('iframe')!;
        expect(frame.hidden && frame.getAttribute('aria-hidden') === 'true', 'hidden').toBe(true);
        expect(frame.hasAttribute('srcdoc') || frame.hasAttribute('src'), 'an empty frame: no document of ours, no script').toBe(false);
        await gate;
        expect(requested).toEqual([`http://${DECOY_HOST}:${DECOY_PORT}/`]);
        expect(DECOY_URL).toBe(`http://${DECOY_HOST}:${DECOY_PORT}/`);
        expect(DECOY_HOST.endsWith('.invalid'), 'a name that can never exist (RFC 6761)').toBe(true);
        expect(DECOY_PORT).toBe(6000);
        expect(knownHostPolicies()).toEqual(["connect-src 'self'", 'connect-src https:']);
        expect(parent.querySelector('iframe'), 'the frame is removed').toBeNull();
        expect(whenHostPoliciesKnown(parent), 'once per page: asked again, it is known').toBeNull();
    });

    it('a Report-Only policy and an event that is not one policy\'s text are ignored; a policy that reports twice is kept once', async () => {
        standIn((_, document) => {
            violation(document, { disposition: 'report', originalPolicy: "connect-src 'none'" });
            violation(document, { disposition: 'enforce', originalPolicy: undefined });
            violation(document, { disposition: 'enforce', originalPolicy: 'connect-src a.example' });
        });
        await whenHostPoliciesKnown(parent);
        expect(knownHostPolicies()).toEqual(['connect-src a.example']);
    });

    it('a page that refuses nothing gives an empty list: known, and nothing to narrow by', async () => {
        standIn(() => {});
        await whenHostPoliciesKnown(parent);
        expect(knownHostPolicies()).toEqual([]);
        expect(Object.isFrozen(knownHostPolicies())).toBe(true);
    });

    it('builds that ask while it runs share it: one read, one frame, every wait answered', async () => {
        const { requested } = standIn(() => {});
        const other = document.createElement('div');
        document.body.append(other);
        const first = whenHostPoliciesKnown(parent);
        const second = whenHostPoliciesKnown(other);
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(document.querySelectorAll('iframe')).toHaveLength(1);
        await Promise.all([first, second]);
        expect(requested).toHaveLength(1);
        expect(knownHostPolicies()).toEqual([]);
    });

    it('waits SETTLE_MS after the decoys settled for their events, which are tasks of their own', async () => {
        vi.useFakeTimers();
        standIn((_, document) => { setTimeout(() => violation(document, { disposition: 'enforce', originalPolicy: 'connect-src late' }), SETTLE_MS - 5); });
        const gate = whenHostPoliciesKnown(parent)!;
        await vi.advanceTimersByTimeAsync(0);
        expect(knownHostPolicies()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        await gate;
        expect(knownHostPolicies()).toEqual(['connect-src late']);
    });

    it('a frame that stays in the document and never loads ends the read at READ_TIMEOUT_MS: unknown, said to have failed, and not tried again', async () => {
        vi.useFakeTimers();
        standIn(() => {}, { loads: false });
        const gate = whenHostPoliciesKnown(parent)!;
        await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
        expect(knownHostPolicies()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(2);
        await gate;
        expect(knownHostPolicies()).toBeNull();
        expect(hostPolicyReadFailed()).toBe(true);
        expect(parent.querySelector('iframe')).toBeNull();
        expect(whenHostPoliciesKnown(parent)).toBeNull();
    });

    it('a frame taken out of the document under every read gives no answer: the read starts again, READ_FRAMES frames in all, then its waits end with nothing kept, and the next build reads again', async () => {
        const { requested } = standIn(() => { parent.querySelector('iframe')?.remove(); });
        await whenHostPoliciesKnown(parent);
        expect(requested).toHaveLength(READ_FRAMES);
        expect(knownHostPolicies()).toBeUndefined();
        expect(hostPolicyReadFailed()).toBe(false);
        expect(parent.querySelector('iframe')).toBeNull();
        vi.restoreAllMocks();
        standIn(() => {});
        const again = whenHostPoliciesKnown(parent);
        expect(again).not.toBeNull();
        await again;
        expect(knownHostPolicies()).toEqual([]);
    });
});

// ---- the read's frame under DOM changes: every await point, every way a frame leaves --------------------------------

/**
 * Frames as a browser has them: each insertion of a frame into the document gives it a new document (and window), whose
 * load is a task of its own; a frame out of the document has neither and never loads. The decoy reports `POLICY`.
 * `hooks.fetch` runs inside the decoy fetch (the read's second await point).
 */
const POLICY = "connect-src 'self'";
function browserFrames(hooks: { fetch?: (frame: HTMLIFrameElement) => void } = {}) {
    const requested: string[] = [];
    const frames: HTMLIFrameElement[] = [];
    const state = new WeakMap<HTMLIFrameElement, { document: EventTarget | null; window: FakeFrame['window']; stale: boolean; listeners: EventListener[] }>();
    const framesIn = (node: Node): HTMLIFrameElement[] => (node instanceof HTMLIFrameElement ? [node] : node instanceof Element ? [...node.querySelectorAll('iframe')] : []);
    const current = (frame: HTMLIFrameElement) => {
        const own = state.get(frame)!;
        if (!frame.isConnected) return null;
        if (own.document === null || own.stale) {
            const doc = new EventTarget();
            own.document = doc;
            own.stale = false;
            own.window = {
                fetch: async (url: string) => {
                    requested.push(url);
                    hooks.fetch?.(frame);
                    violation(doc, { disposition: 'enforce', originalPolicy: POLICY });
                    throw new TypeError('Failed to fetch');
                },
            };
        }
        return own;
    };
    const observer = new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.removedNodes) for (const frame of framesIn(node)) if (state.has(frame)) state.get(frame)!.stale = true;
            for (const node of record.addedNodes) {
                for (const frame of framesIn(node)) {
                    if (!state.has(frame)) continue;
                    setTimeout(() => { if (frame.isConnected) for (const listener of state.get(frame)!.listeners) listener.call(frame, new Event('load')); }, 0);
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const element = create(tag);
        if (tag !== 'iframe') return element;
        const frame = element as HTMLIFrameElement;
        frames.push(frame);
        state.set(frame, { document: null, window: null, stale: false, listeners: [] });
        Object.defineProperty(frame, 'contentWindow', { get: () => current(frame)?.window ?? null });
        Object.defineProperty(frame, 'contentDocument', { get: () => current(frame)?.document ?? null });
        const original = frame.addEventListener.bind(frame);
        frame.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
            if (type === 'load') { state.get(frame)!.listeners.push(listener as EventListener); return; } // only this model's loads, not jsdom's
            original(type, listener, options);
        }) as typeof frame.addEventListener;
        return frame;
    }) as typeof document.createElement);
    return { requested, frames, stop: () => observer.disconnect() };
}

type Point = 'before its load' | 'during the decoy' | 'during the settle';
type Leave = 'its element is removed' | 'its element is moved' | 'the frame is removed' | 'the frame is put back (a new document)';
const POINTS: readonly Point[] = ['before its load', 'during the decoy', 'during the settle'];
const LEAVES: readonly Leave[] = ['its element is removed', 'its element is moved', 'the frame is removed', 'the frame is put back (a new document)'];

describe("the read's frame leaves the document at each await point: every waiter is answered by a frame that stayed, and a removal caches nothing", () => {
    for (const point of POINTS) {
        for (const leave of LEAVES) {
            it(`${point}, ${leave}`, async () => {
                vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
                // A's element reads (it asked first); B's waits on the same read
                const a = document.createElement('div');
                const b = document.createElement('div');
                document.body.append(a, b);
                let acted = false;
                const act = () => {
                    if (acted) return;
                    acted = true;
                    const frame = a.querySelector('iframe');
                    if (leave === 'its element is removed') { a.remove(); hostPolicyReaderLeft(a); }
                    else if (leave === 'its element is moved') { a.remove(); document.body.append(a); hostPolicyReaderLeft(a); waits.push(track(whenHostPoliciesKnown(a))); }
                    else if (leave === 'the frame is removed') frame!.remove();
                    else { frame!.remove(); a.append(frame!); }
                };
                const model = browserFrames({
                    fetch: () => {
                        if (point === 'during the decoy') act();
                        if (point === 'during the settle') setTimeout(act, SETTLE_MS / 2);
                    },
                });
                const answered: boolean[] = [];
                const track = (wait: Promise<void> | null) => { const index = answered.push(wait === null) - 1; void wait?.then(() => { answered[index] = true; }); return wait; };
                const waits: Array<Promise<void> | null> = [track(whenHostPoliciesKnown(a)), track(whenHostPoliciesKnown(b))];
                expect(a.querySelectorAll('iframe'), 'the first to ask holds the frame').toHaveLength(1);
                if (point === 'before its load') act();

                // detected at once where the element says so; the timeout only where nothing does (a frame removed before its load)
                const bound = leave === 'the frame is removed' && point === 'before its load' ? READ_TIMEOUT_MS + SETTLE_MS * 4 : SETTLE_MS * 4;
                await vi.advanceTimersByTimeAsync(bound);
                expect(acted).toBe(true);
                expect(answered.every(Boolean), 'every wait ended').toBe(true);
                expect(knownHostPolicies(), 'answered by a frame that stayed in the document').toEqual([POLICY]);
                expect(hostPolicyReadFailed(), 'a removal is never a failure').toBe(false);
                expect(document.querySelectorAll('iframe'), 'no frame is left').toHaveLength(0);
                // one decoy per frame that loaded in the document: a frame that left before its load sent none
                expect(model.requested.length, 'the decoys sent').toBe(point === 'before its load' ? 1 : 2);
                model.stop();
            });
        }
    }

    it('the only waiter leaves: its wait ends at once, nothing is cached, no frame is left, and the next build reads again', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const model = browserFrames();
        let ended = false;
        void whenHostPoliciesKnown(parent)!.then(() => { ended = true; });
        parent.remove();
        hostPolicyReaderLeft(parent);
        await vi.advanceTimersByTimeAsync(0);
        expect(ended).toBe(true);
        expect(knownHostPolicies()).toBeUndefined();
        expect(hostPolicyReadFailed()).toBe(false);
        expect(document.querySelectorAll('iframe')).toHaveLength(0);
        document.body.append(parent);
        const again = whenHostPoliciesKnown(parent);
        expect(again).not.toBeNull();
        await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
        await again;
        expect(knownHostPolicies()).toEqual([POLICY]);
        model.stop();
    });

    it('a list reordered in one task loses one frame, not one per element moved', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const model = browserFrames();
        const list = Array.from({ length: 5 }, () => document.createElement('div'));
        document.body.append(...list);
        const waits = list.map(element => whenHostPoliciesKnown(element));
        // the keyed reorder: every element moved, each one's build ends and a new one asks
        for (const element of [...list].reverse()) {
            document.body.append(element);
            hostPolicyReaderLeft(element);
            waits.push(whenHostPoliciesKnown(element));
        }
        await vi.advanceTimersByTimeAsync(SETTLE_MS * 4);
        await Promise.all(waits);
        expect(knownHostPolicies()).toEqual([POLICY]);
        expect(model.frames).toHaveLength(2);
        model.stop();
    });

    it('a reader that keeps leaving: after READ_FRAMES frames the waits end with no answer (the builds narrow to nothing), and nothing is cached', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const model = browserFrames({ fetch: frame => frame.remove() });
        let ended = false;
        void whenHostPoliciesKnown(parent)!.then(() => { ended = true; });
        await vi.advanceTimersByTimeAsync(SETTLE_MS * 4 * READ_FRAMES);
        expect(ended).toBe(true);
        expect(model.requested).toHaveLength(READ_FRAMES);
        expect(knownHostPolicies()).toBeUndefined();
        expect(hostPolicyReadFailed()).toBe(false);
        model.stop();
    });
});
