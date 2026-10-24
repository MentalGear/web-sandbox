import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The element hands the host page's origin to the config (host.ts, `normaliseConfig(copy, { hostOrigin })`, from
 * host-site.ts `hostPageOrigin`: `self.origin` of its realm), so the host-reach warnings fire in a real element: an origin
 * list naming the page's own origin or a host on its site, and `fetchBridge.allow` naming the page's own origin
 * (BD1:NEW-1; docs/API.md, `origins`). test/unit/config-schema.test.ts gives the origin by hand; these go through
 * `setConfig`.
 */

async function mount(config: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    el.setConfig(config);
    return el;
}

const warnings = () => (console.warn as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe("the element tells the config the host page's origin (BD1:NEW-1)", () => {
    it("the page has an origin, and the element's realm reads it as self.origin", () => {
        expect(globalThis.origin).toMatch(/^https?:\/\//);
    });

    it("origins.connect naming the host page's own origin is dropped with one warning, in every mode", async () => {
        for (const mode of ['strict', 'cooperative', 'worker']) {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const el = await mount({ mode, capabilities: [], origins: { connect: [globalThis.origin] } });
            expect(warnings().filter(m => m.includes(' dropped ') && m.includes("the host page's own origin")), mode).toHaveLength(1);
            expect(el._origins.connect, mode).toEqual([]);
            vi.restoreAllMocks();
            document.body.replaceChildren();
        }
    });

    it("fetchBridge.allow naming the host page's own origin warns once", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mount({ fetchBridge: { allow: [globalThis.origin] } });
        expect(warnings().filter(m => m.includes("fetchBridge.allow lists the host page's own origin"))).toHaveLength(1);
    });
});

describe("the element decides the host page's site from self.origin, with no probe of the page (S74, host-site.ts)", () => {
    // A realm whose settings are https://app.wiring.co.uk while its document's URL says nothing of it (a same-origin
    // srcdoc or a DOM-built about:blank frame: location.origin 'null', location.hostname ''), with a cookie accessor that
    // keeps nothing (a consent manager's gate): neither is read.
    const HOST = 'https://app.wiring.co.uk';
    let cookieWrites = 0;
    let cookieReads = 0;

    function realmAt(origin: string) {
        vi.stubGlobal('origin', origin);
        vi.stubGlobal('location', { origin: 'null', hostname: '', href: 'about:srcdoc' });
        Object.defineProperty(document, 'cookie', {
            configurable: true,
            get: () => { cookieReads++; return ''; },
            set: () => { cookieWrites++; },
        });
    }

    afterEach(() => {
        vi.unstubAllGlobals();
        delete (document as any).cookie;
        cookieWrites = 0;
        cookieReads = 0;
    });

    it("a sibling subdomain and the page's own origin are on the page's site: every mode drops them, and the cookie jar is never touched", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        realmAt(HOST);
        const cooperative = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], origins: { connect: ['https://api.wiring.co.uk', HOST], images: ['https://cdn.other.example'] } });
        expect(warnings().filter(m => m.includes(`origins.connect dropped https://api.wiring.co.uk (on the host page's site), ${HOST} (the host page's own origin)`))).toHaveLength(1);
        expect(cooperative._origins.connect).toEqual([]);
        expect(cooperative._origins.images).toEqual(['https://cdn.other.example']);

        const strict = await mount({ origins: { images: ['https://api.wiring.co.uk'] } });
        expect(warnings().filter(m => m.includes("origins.images dropped https://api.wiring.co.uk (on the host page's site)"))).toHaveLength(1);
        expect(strict._origins.images).toEqual([]);
        expect({ cookieWrites, cookieReads }).toEqual({ cookieWrites: 0, cookieReads: 0 });
    });

    it("an opaque realm ('null', a sandboxed host document) keeps its entries, with the warning that says so", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        realmAt('null');
        const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], origins: { connect: ['https://api.wiring.co.uk'] } });
        expect(el._origins.connect).toEqual(['https://api.wiring.co.uk']);
        expect(warnings().filter(m => m.includes('origins.connect lists https://api.wiring.co.uk from a host page whose origin is opaque'))).toHaveLength(1);
    });
});
