import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The element hands the host page to the config (host.ts, `normaliseConfig(copy, { hostOrigin, hostSites })`, from
 * host-site.ts `hostPageOrigin` and `hostSiteOrigins`: `self.origin` of its realm, its top-level URL's and its ancestors'),
 * so the host-reach warnings fire in a real element: an origin
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

describe("the element decides the host page's site from its realm, with no probe of the page (S74, host-site.ts)", () => {
    // A realm whose settings are https://app.wiring.co.uk while its document's URL says nothing of it (a same-origin
    // srcdoc or a DOM-built about:blank frame: location.origin 'null', location.hostname ''), framed by a page of its own
    // origin, with a cookie accessor that keeps nothing (a consent manager's gate): neither the URL nor the jar is read.
    const HOST = 'https://app.wiring.co.uk';
    let cookieWrites = 0;
    let cookieReads = 0;

    function realmAt(origin: string, framedBy: string) {
        const top = { origin: framedBy };
        vi.stubGlobal('origin', origin);
        vi.stubGlobal('location', { origin: 'null', hostname: '', href: 'about:srcdoc', ancestorOrigins: [framedBy] });
        vi.stubGlobal('top', top);
        vi.stubGlobal('parent', top);
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
        realmAt(HOST, HOST);
        const cooperative = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], origins: { connect: ['https://api.wiring.co.uk', HOST], images: ['https://cdn.other.example'] } });
        expect(warnings().filter(m => m.includes(`origins.connect dropped https://api.wiring.co.uk (on the host page's site), ${HOST} (the host page's own origin)`))).toHaveLength(1);
        expect(cooperative._origins.connect).toEqual([]);
        expect(cooperative._origins.images).toEqual(['https://cdn.other.example']);

        const strict = await mount({ origins: { images: ['https://api.wiring.co.uk'] } });
        expect(warnings().filter(m => m.includes("origins.images dropped https://api.wiring.co.uk (on the host page's site)"))).toHaveLength(1);
        expect(strict._origins.images).toEqual([]);
        expect({ cookieWrites, cookieReads }).toEqual({ cookieWrites: 0, cookieReads: 0 });
    });

    it("the site of the page that frames it counts too (BD4:ISO-3): an origin on it is dropped in every mode", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        realmAt(HOST, 'https://www.framer.example');
        const worker = await mount({ mode: 'worker', origins: { connect: ['https://api.framer.example', 'wss://api.framer.example', 'https://api.other.example'] } });
        expect(worker._origins.connect).toEqual(['https://api.other.example']);
        expect(warnings().filter(m => m.includes("origins.connect dropped https://api.framer.example (on the host page's site), wss://api.framer.example (on the host page's site)"))).toHaveLength(1);
    });

    it("an opaque realm ('null', a sandboxed host document) leaves the site undecided: every entry a cookie carrier of the mode reaches is dropped, with the warning that says why", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        realmAt('null', HOST);
        const worker = await mount({ mode: 'worker', origins: { connect: ['https://api.wiring.co.uk', 'https://api.other.example', 'wss://api.other.example'] } });
        expect(worker._origins.connect).toEqual(['https://api.other.example']);
        expect(warnings().filter(m => m.includes("origins.connect dropped https://api.wiring.co.uk (on the host page's site)"))).toHaveLength(1);
        expect(warnings().filter(m => m.includes("origins.connect dropped wss://api.other.example (the host page's site is undecided): the host page's site cannot be decided"))).toHaveLength(1);
        const cooperative = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], origins: { images: ['https://cdn.other.example'] } });
        expect(cooperative._origins.images).toEqual([]);
    });
});
