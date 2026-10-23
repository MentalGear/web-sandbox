import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECOY_HOST, DECOY_PORT, DECOY_URL, forgetHostPolicies, hostPolicyReadFailed, knownHostPolicies, READ_TIMEOUT_MS, SETTLE_MS, whenHostPoliciesKnown } from '@src/lib/host-csp';

/**
 * The read of the host page's policy (src/lib/host-csp.ts), against a frame that behaves as a browser's does: jsdom has no
 * frame that can fetch, so a frame is stood in for here (a window with a `fetch` that reports what the page's policy
 * would, a document that takes the events), and the real engines are the e2e spec's (test/e2e/connect-uniform.spec.ts).
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
    vi.restoreAllMocks();
    vi.useRealTimers();
    parent.remove();
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

    it('builds that ask while it runs share it: one read, one frame', async () => {
        const { requested } = standIn(() => {});
        const first = whenHostPoliciesKnown(parent);
        const second = whenHostPoliciesKnown(parent);
        expect(second).toBe(first);
        expect(parent.querySelectorAll('iframe')).toHaveLength(1);
        await first;
        expect(requested).toHaveLength(1);
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

    it('a frame that never loads ends the read at READ_TIMEOUT_MS: unknown, said to have failed, and not tried again', async () => {
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

    it('a frame taken out of the document under the read saw nothing: no answer is kept, and the next build reads again', async () => {
        standIn(() => { parent.querySelector('iframe')?.remove(); });
        await whenHostPoliciesKnown(parent);
        expect(knownHostPolicies()).toBeUndefined();
        expect(hostPolicyReadFailed()).toBe(false);
        vi.restoreAllMocks();
        standIn(() => {});
        const again = whenHostPoliciesKnown(parent);
        expect(again).not.toBeNull();
        await again;
        expect(knownHostPolicies()).toEqual([]);
    });
});
