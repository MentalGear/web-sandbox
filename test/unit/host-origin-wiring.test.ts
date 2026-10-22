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

    it("origins.connect naming the host page's own origin warns once", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], origins: { connect: [location.origin] } });
        expect(warnings().filter(m => m.includes(' lists ') && m.includes("the host page's own origin"))).toHaveLength(1);
    });

    it("origins.images on a subdomain of the host page warns once: same site", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], origins: { images: [`https://cdn.${location.hostname}`] } });
        expect(warnings().filter(m => m.includes('origins.images lists') && m.includes("on the host page's site"))).toHaveLength(1);
    });

    it("fetchBridge.allow naming the host page's own origin warns once", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mount({ fetchBridge: { allow: [location.origin] } });
        expect(warnings().filter(m => m.includes("fetchBridge.allow lists the host page's own origin"))).toHaveLength(1);
    });
});
