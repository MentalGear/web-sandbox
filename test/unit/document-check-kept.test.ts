import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The check of the served file (src/lib/document-check.ts; design 03), its pass: the library's file is answered once
 * per registration, so every later build of every element frames it at once, with no request and no wait. A registration
 * of its own (one per test file, as one per page). The unit environment has no `fetch`: a stand-in is installed before the
 * library's modules are evaluated (test/unit/document-check.test.ts does the same).
 */

const server = vi.hoisted(() => {
    const state = { requests: 0, body: '' };
    Object.defineProperty(globalThis, 'fetch', {
        value: async () => {
            state.requests++;
            return new Response(state.body, { status: 200, headers: { 'content-type': 'text/html' } });
        },
        writable: true,
        configurable: true,
    });
    return state;
});

const { defineWebSandbox } = await import('@src/host');
const { servedDocument } = await import('../../scripts/served-document');
const { keptDocumentCheck } = await import('@src/lib/document-check');
const { registeredDocumentUrl } = await import('@src/lib/document-url');

server.body = servedDocument().text;
defineWebSandbox({ documentUrl: '/sealed-document.html' });

const APP = { html: '<p>one</p>', entry: 'app.js', files: { 'app.js': 'bridge.expose("ping", () => "pong");' } };
const frameOf = (el: any): HTMLIFrameElement | null => el.shadowRoot.querySelector('iframe');
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    document.body.replaceChildren();
});

describe('the pass, kept for the registration', () => {
    it('the first build waits for the check and then frames the file; every later build, of any element, frames it at once: one request', async () => {
        const first = document.createElement('web-sandbox') as any;
        document.body.appendChild(first);
        first.start(APP);
        expect(frameOf(first)).toBeNull();
        for (let i = 0; i < 20 && frameOf(first) === null; i++) await settled();
        expect(frameOf(first)!.getAttribute('src')).toBe(registeredDocumentUrl());
        expect(keptDocumentCheck(registeredDocumentUrl()!)).toEqual({ finding: null });

        first.reset();
        expect(frameOf(first)).not.toBeNull(); // framed in the reset itself: nothing to wait for
        const second = document.createElement('web-sandbox') as any;
        document.body.appendChild(second);
        second.start(APP);
        expect(frameOf(second)).not.toBeNull();
        second.remove();
        document.body.appendChild(second);
        expect(frameOf(second)).not.toBeNull();
        await settled();
        expect(server.requests).toBe(1);
        expect([first.state, second.state]).toEqual(['loading', 'loading']); // jsdom loads no frame: no view answers
    });
});
