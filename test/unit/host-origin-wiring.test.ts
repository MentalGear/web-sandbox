import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The element hands the host page's origin to the config (host.ts, `normaliseConfig(copy, { hostOrigin })`), so the
 * host-reach warnings fire in a real element: an origin list naming the page's own origin or a host on its site, and
 * `fetchBridge.allow` naming the page's own origin (BD1:NEW-1; docs/API.md, `origins`). test/unit/config-schema.test.ts
 * gives the origin by hand; these go through `setConfig`.
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
    it('the page has an origin', () => {
        expect(location.origin).toMatch(/^https?:\/\//);
    });

    it("origins.connect naming the host page's own origin is dropped with one warning, in every mode", async () => {
        for (const mode of ['strict', 'cooperative', 'worker']) {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const el = await mount({ mode, capabilities: [], origins: { connect: [location.origin] } });
            expect(warnings().filter(m => m.includes(' dropped ') && m.includes("the host page's own origin")), mode).toHaveLength(1);
            expect(el._origins.connect, mode).toEqual([]);
            vi.restoreAllMocks();
            document.body.replaceChildren();
        }
    });

    it("origins.images on a subdomain of the host page is dropped with one warning: same site", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], origins: { images: [`https://cdn.${location.hostname}`] } });
        expect(warnings().filter(m => m.includes('origins.images dropped') && m.includes("on the host page's site"))).toHaveLength(1);
        expect(el._origins.images).toEqual([]);
    });

    it("fetchBridge.allow naming the host page's own origin warns once", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mount({ fetchBridge: { allow: [location.origin] } });
        expect(warnings().filter(m => m.includes("fetchBridge.allow lists the host page's own origin"))).toHaveLength(1);
    });
});

describe("the element asks the browser which hosts share the page's site (S74, host-site.ts)", () => {
    // a page at app.wiring.co.uk: a cookie jar that keeps a Domain it may set (not a public suffix), the page's location
    const SUFFIXES = new Set(['uk', 'co.uk']);
    const HOST = 'app.wiring.co.uk';

    function pageAt(host: string) {
        const stored = new Set<string>();
        vi.stubGlobal('location', { origin: `https://${host}`, hostname: host });
        Object.defineProperty(document, 'cookie', {
            configurable: true,
            get: () => [...stored].map(name => `${name}=1`).join('; '),
            set: (line: string) => {
                const [pair, ...attributes] = line.split(';').map(part => part.trim());
                const name = pair!.split('=')[0]!;
                const domain = attributes.find(attribute => attribute.startsWith('Domain='))?.slice(7) ?? host;
                if (attributes.includes('Max-Age=0')) stored.delete(name);
                else if (domain === host || (host.endsWith(`.${domain}`) && !SUFFIXES.has(domain))) stored.add(name);
            },
        });
    }

    afterEach(() => {
        vi.unstubAllGlobals();
        delete (document as any).cookie;
    });

    it("a sibling subdomain is on the page's site: every mode drops it", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        pageAt(HOST);
        const cooperative = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], origins: { connect: ['https://api.wiring.co.uk'], images: ['https://co.uk'] } });
        expect(warnings().filter(m => m.includes("origins.connect dropped https://api.wiring.co.uk (on the host page's site)"))).toHaveLength(1);
        expect(cooperative._origins.connect).toEqual([]);
        // a public suffix above the page is not on its site, though the name check would have said so
        expect(warnings().filter(m => m.includes('origins.images'))).toEqual([]);
        expect(cooperative._origins.images).toEqual(['https://co.uk']);

        const strict = await mount({ origins: { connect: ['https://api.wiring.co.uk'] } });
        expect(warnings().filter(m => m.includes("origins.connect dropped https://api.wiring.co.uk (on the host page's site)"))).toHaveLength(2);
        expect(strict._origins.connect).toEqual([]);
        expect(document.cookie).toBe('');
    });
});
