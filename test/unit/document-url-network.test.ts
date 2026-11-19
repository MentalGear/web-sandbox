import '@src/network'; // the network build: this file tests a registration only that build allows (ADR-009)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineWebSandbox } from '@src/host';
import { registeredDocumentUrl } from '@src/lib/document-url';
import { reasonText } from '@src/lib/reasons';

/**
 * The build with the network modes registers without `documentUrl` (design 03, "The network build"): strict, cooperative
 * and worker mode keep documents of their own, so they need none. Sealed mode has no view but the served file, so a
 * sealed app on such an element is refused by start() with a named reason (`noDocumentUrl`), never built some other way.
 */

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const newElement = () => document.createElement('web-sandbox') as any;
const NO_DOCUMENT = `[Sandbox] start(): ${reasonText('noDocumentUrl')}.`;

describe('a registration without documentUrl, in the build with the network modes', () => {
    it('defines the element and stores no URL; a second definition without one does nothing, with one it throws', () => {
        defineWebSandbox({});
        expect(customElements.get('web-sandbox')).toBeDefined();
        expect(registeredDocumentUrl()).toBeNull();
        expect(() => defineWebSandbox({ tagName: 'web-sandbox' })).not.toThrow();
        expect(() => defineWebSandbox({ documentUrl: '/sealed-document.html' })).toThrow(`[Sandbox] defineWebSandbox(): ${reasonText('documentUrlChanged')}.`);
        expect(registeredDocumentUrl()).toBeNull();
    });

    it("start() of a sealed app throws noDocumentUrl's refusal, whether the mode is named or left out, and leaves the element new", () => {
        for (const grants of [undefined, {}, { mode: 'sealed' }]) {
            const el = newElement();
            document.body.append(el);
            expect(() => el.start({ html: '<p>x</p>' }, grants)).toThrow(NO_DOCUMENT);
            expect([el.started, el.state, el.shadowRoot.querySelectorAll('iframe').length]).toEqual([false, 'idle', 0]);
        }
    });

    it('the network modes start without it', () => {
        for (const mode of ['strict', 'cooperative', 'worker']) {
            const el = newElement();
            document.body.append(el);
            el.start({ html: '<p>x</p>' }, { mode, hostContentSecurityPolicy: false });
            expect([el.started, el.state], mode).toEqual([true, 'loading']);
        }
    });
});
