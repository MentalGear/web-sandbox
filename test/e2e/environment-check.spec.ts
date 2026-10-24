import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import type { Page } from '@playwright/test';

/**
 * The environment check (S74, class B; src/lib/environment-check.ts): the first statement of every bootstrap that runs
 * in a sandbox document confirms that the document is the one the library built (an opaque origin, about:srcdoc, the
 * base about:blank). Three things only a browser shows, on all three engines:
 *   - a host page whose Content-Security-Policy has `base-uri 'self'` or `'none'` refuses the `<base>` the wrapper sets
 *     (frames inherit the host page's policy), so the guest's base URL would be the host page's URL: the bootstrap stays
 *     inert, the guest's markup after it never runs, and the sandbox ends with the named reason, in strict, cooperative
 *     and worker mode and with the fetch bridge; with `about:` allowed (or the directive omitted) all of them run;
 *   - a copy of a bootstrap placed outside a sandbox document (the host page, a frame of its own origin, a sandboxed
 *     frame under the host page's base, one loaded from a blob: URL) registers nothing and builds nothing, and the
 *     element ignores the refusal it posts, since it is not the element's frame;
 *   - in a document the library built, the same copies run (the control: the probe sees what a bootstrap does).
 */

const BASE = "the sandbox document's base URL is not about:blank: the host page's Content-Security-Policy must allow the library's <base> (base-uri must include about: or be omitted; see docs/API.md#host-page-policy)";

type HostEvent = { type: 'ready' | 'terminated'; reason: string | null };

const ENTRY = `sandboxView.render('<p id="hello">hi</p>'); console.log('ENTRY RAN');`;
// The guest's script reports itself to the host page directly: the library's relay is not in the way, so a guest that ran
// without the bootstrap would still be seen.
const GUEST_SCRIPT = `<script>top.postMessage({ guestRan: true }, '*')</script>`;
const MODES: readonly [name: string, config: object][] = [
    ['strict', { entry: 'main.js' }],
    ['strict with the fetch bridge', { entry: 'main.js', fetchBridge: { allow: ['https://api.example'] } }],
    ['cooperative', { mode: 'cooperative', capabilities: ['allow-scripts'], html: `<p>x</p>${GUEST_SCRIPT}` }],
    ['worker', { mode: 'worker' }],
];

/** Opens the harness with the host page's policy; `collect` gathers what the page hears from frames. */
async function openWithPolicy(page: Page, csp?: string) {
    await page.addInitScript(() => {
        if (window !== window.top) return;
        const w = window as any;
        w.guestMessages = [];
        w.foreignRefusals = [];
        w.probes = [];
        window.addEventListener('message', (event: MessageEvent) => {
            const data = event.data;
            if (data?.guestRan) w.guestMessages.push(true);
            if (data?.type === 'ENVIRONMENT_REFUSED') w.foreignRefusals.push(data.refused);
            if (data?.probe) w.probes.push(data);
        });
    });
    await page.goto(`${ORIGIN}/__host-policy${csp ? `?${new URLSearchParams({ csp })}` : ''}`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
}

/** setConfig() and the events from then on, once it settled (and a moment after, for a termination right after `ready`). */
async function configure(sandbox: SandboxDriver, config: object): Promise<HostEvent[]> {
    await sandbox.page.evaluate(() => { (window as any).sandboxEvents.length = 0; });
    await sandbox.page.evaluate((c) => whenSettled(s => s.setConfig(c)), config as any);
    await sandbox.page.waitForTimeout(400);
    return sandbox.page.evaluate(() => [...(window as any).sandboxEvents]);
}

test.describe('a host page policy with base-uri', () => {
    for (const csp of ["base-uri 'self'", "base-uri 'none'"]) {
        for (const [name, config] of MODES) {
            test(`${csp}, ${name}: inert bootstrap, no guest script, and the sandbox ends with the named reason`, async ({ sandbox, page }) => {
                await openWithPolicy(page, csp);
                await sandbox.registerFiles({ 'main.js': ENTRY });
                expect(await configure(sandbox, config)).toEqual([{ type: 'terminated', reason: BASE }]);
                expect(await sandbox.logs()).toContain(`[Sandbox] ${BASE}`);
                expect(await page.evaluate(() => (window as any).guestMessages)).toEqual([]);
                expect(await sandbox.state()).toBe('terminated');
            });
        }
    }

    for (const csp of ["base-uri 'self' about:", "base-uri about:", 'img-src *']) {
        for (const [name, config] of MODES) {
            test(`${csp}: ${name} runs (the directive allows about:, or is omitted)`, async ({ sandbox, page }) => {
                const warnings: string[] = [];
                page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()); });
                await openWithPolicy(page, csp);
                await sandbox.registerFiles({ 'main.js': ENTRY });
                expect(await configure(sandbox, config)).toEqual([{ type: 'ready', reason: null }]);
                if (name === 'cooperative') await expect.poll(() => page.evaluate(() => (window as any).guestMessages)).toEqual([true]);
                if (name === 'strict with the fetch bridge') expect(warnings.filter(text => text.includes("fetch bridge's frame did not start"))).toEqual([]);
                expect(await sandbox.state()).toBe('ready');
            });
        }
    }
});

// ---- a copy of a bootstrap, placed elsewhere

type Kind = 'view' | 'bridge' | 'cooperative' | 'worker-frame';
type Texts = Record<Kind, string>;
type Probe = { effects: string[]; globals: string[]; after: boolean };

/** The text of each bootstrap, as the element writes it into its documents (read from the documents of four builds). */
async function bootstrapTexts(sandbox: SandboxDriver): Promise<Texts> {
    const read = async (config: object) => {
        expect(await configure(sandbox, config)).toEqual([{ type: 'ready', reason: null }]);
        return sandbox.page.evaluate(() => {
            const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
            const frames = [...(document.querySelector('web-sandbox') as any).shadowRoot.querySelectorAll('iframe')] as HTMLIFrameElement[];
            const wrapper = parse(frames[0]!.srcdoc);
            const scriptOf = (doc: Document) => doc.head.querySelector('script')!.textContent!;
            return {
                inner: scriptOf(parse(wrapper.querySelector('iframe')!.getAttribute('srcdoc')!)),
                bridge: frames[1] ? scriptOf(parse(frames[1].srcdoc)) : null,
            };
        });
    };
    await sandbox.registerFiles({ 'main.js': ENTRY });
    const strict = await read({ entry: 'main.js', fetchBridge: { allow: ['https://api.example'] } });
    const cooperative = await read({ mode: 'cooperative', capabilities: ['allow-scripts'], html: '<p>x</p>' });
    const worker = await read({ mode: 'worker' });
    expect(strict.inner).toBe(strict.bridge); // the one hashed bootstrap: the view's document and the bridge frame's
    return { view: strict.inner, bridge: strict.bridge!, cooperative: cooperative.inner, 'worker-frame': worker.inner };
}

type Where = 'the host page itself' | "a frame of the host page's own origin" | "a sandboxed srcdoc frame under the host page's base" | 'a sandboxed frame loaded from a blob: URL' | "a sandboxed srcdoc frame with the library's base";

/**
 * Places `text` as the script of a document of its own, behind a probe that records what a bootstrap does (the
 * listeners it registers, the channels, blob: URLs and workers it makes) and whether a script after it ran. Returns what the
 * probe reported.
 */
async function place(page: Page, text: string, role: string | null, where: Where): Promise<Probe> {
    return page.evaluate(async ({ text, role, where }) => {
        const SETUP = `(() => {
            const effects = [];
            window.__effects = effects;
            const real = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function (type, ...rest) { effects.push('listener ' + type); return real.call(this, type, ...rest); };
            const RealChannel = MessageChannel;
            window.MessageChannel = function () { effects.push('MessageChannel'); return new RealChannel(); };
            const createObjectURL = URL.createObjectURL;
            URL.createObjectURL = function (...args) { effects.push('createObjectURL'); return createObjectURL.apply(this, args); };
            const RealWorker = window.Worker;
            window.Worker = function (...args) { effects.push('Worker'); return new RealWorker(...args); };
            setTimeout(() => {
                const globals = ['__sandboxViewRuns', '__sandboxBridgeRuns', 'sandboxFiles', 'bridge'].filter(name => name in window);
                const report = { probe: true, effects, globals, after: window.__after === true };
                if (window.parent !== window) window.parent.postMessage(report, '*'); else window.__topProbe = report;
            }, 400);
        })();`;
        const w = window as any;
        w.probes.length = 0;
        w.foreignRefusals.length = 0;
        w.guestMessages.length = 0;
        if (where === 'the host page itself') {
            const run = (source: string, attributes: Record<string, string> = {}) => {
                const script = document.createElement('script');
                for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
                script.textContent = source;
                document.head.appendChild(script);
                script.remove();
            };
            run(SETUP);
            run(text, role ? { 'data-role': role } : {});
            run('window.__after = true;');
            await new Promise(resolve => setTimeout(resolve, 600));
            return w.__topProbe as Probe;
        }
        const base = where === "a sandboxed srcdoc frame with the library's base" ? '<base href="about:blank">' : '';
        const document_ = `<!DOCTYPE html><html><head>${base}<script>${SETUP}</script><script${role ? ` data-role="${role}"` : ''}>${text}</script><script>window.__after = true;</script></head><body></body></html>`;
        const frame = document.createElement('iframe');
        if (where !== "a frame of the host page's own origin") frame.setAttribute('sandbox', 'allow-scripts');
        if (where === 'a sandboxed frame loaded from a blob: URL') frame.src = URL.createObjectURL(new Blob([document_], { type: 'text/html' }));
        else frame.srcdoc = document_;
        const probe = new Promise<Probe>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no report from ${where}`)), 5000);
            const poll = setInterval(() => {
                if (w.probes.length === 0) return;
                clearTimeout(timer);
                clearInterval(poll);
                resolve(w.probes[0]);
            }, 50);
        });
        document.body.appendChild(frame);
        try {
            return await probe;
        } finally {
            frame.remove();
        }
    }, { text, role, where });
}

const KINDS: readonly Kind[] = ['view', 'bridge', 'cooperative', 'worker-frame'];

test.describe('a copy of a bootstrap outside a sandbox document', () => {
    // [where, the row of the table that refuses it, or null where there is no host page above to tell]
    const OUTSIDE: readonly [Where, string | null][] = [
        ['the host page itself', null],
        ["a frame of the host page's own origin", 'origin'],
        ["a sandboxed srcdoc frame under the host page's base", 'base'],
        ['a sandboxed frame loaded from a blob: URL', 'url'],
    ];

    test('registers nothing and builds nothing; the element ignores the refusal (it is no frame of the element)', async ({ sandbox, page }) => {
        await openWithPolicy(page);
        const texts = await bootstrapTexts(sandbox);
        await sandbox.registerFiles({ 'main.js': ENTRY });
        expect(await configure(sandbox, { entry: 'main.js' })).toEqual([{ type: 'ready', reason: null }]);
        await page.evaluate(() => { (window as any).sandboxEvents.length = 0; });

        // the control: in a document the library built, the probe sees what each does
        for (const kind of KINDS) {
            const probe = await place(page, texts[kind], kind === 'bridge' ? 'fetch-bridge' : null, "a sandboxed srcdoc frame with the library's base");
            expect(probe.effects.length, `${kind} in a built document`).toBeGreaterThan(0);
            expect(probe.after, `${kind} in a built document`).toBe(true);
            expect(await page.evaluate(() => (window as any).foreignRefusals), `${kind} in a built document`).toEqual([]);
        }

        for (const [where, refused] of OUTSIDE) {
            for (const kind of KINDS) {
                const label = `${kind} in ${where}`;
                const probe = await place(page, texts[kind], kind === 'bridge' ? 'fetch-bridge' : null, where);
                expect(probe.effects, label).toEqual([]);
                expect(probe.globals, label).toEqual([]);
                // the cooperative guest's document stops its parser: what follows the bootstrap never runs (only in a
                // document that reads like the library's own frame: an opaque origin and about:srcdoc)
                expect(probe.after, label).toBe(!(kind === 'cooperative' && refused === 'base'));
                expect(await page.evaluate(() => (window as any).foreignRefusals), label).toEqual(refused === null ? [] : [refused]);
            }
        }

        await page.waitForTimeout(300);
        expect(await sandbox.state()).toBe('ready');
        expect(await page.evaluate(() => (window as any).sandboxEvents)).toEqual([]);
    });
});

// BD3:TST-7 (class B): the element takes a refusal only from the guest frame's window or the bridge frame's, only as a
// trusted message, and only by a row of its own table. These ran as `toContain` pins of the source (environment-gate.test.ts),
// which a mutant that kept the pinned line and made the check vacuous passed; they run here with real messages.
const FORGE = (refused: string, through = 'parent') => `${through}.postMessage({ type: 'ENVIRONMENT_REFUSED', refused: ${JSON.stringify(refused)} }, '*')`;

test.describe('the refusal the element takes (BD3:TST-7)', () => {
    test("a sibling frame of the host page cannot end the sandbox with a forged refusal; the guest's own window ends its own sandbox (the positive control)", async ({ sandbox, page }) => {
        expect(await sandbox.mount({ mode: 'strict' })).toBe('ready');
        // a frame of the host page that is not the sandbox's (an ad, a widget) posts to the host window
        await page.evaluate((code) => {
            const sibling = document.createElement('iframe');
            sibling.srcdoc = `<script>${code}<\/script>`;
            document.body.appendChild(sibling);
        }, `${FORGE('origin')}; ${FORGE('url')}; ${FORGE('isolated')}`);
        await page.waitForTimeout(500);
        expect(await sandbox.state(), 'a forged refusal from a sibling frame changes nothing').toBe('ready');
        expect(await sandbox.terminations()).toEqual([]);

        // the same message from the guest frame's own window (cooperative mode: guest code can post to the host page)
        expect(await sandbox.mount({ mode: 'cooperative', capabilities: ['allow-scripts'], html: `<p>x</p><script>${FORGE('origin', 'parent.parent')}<\/script>` })).toBe('ready');
        await expect.poll(() => sandbox.state()).toBe('terminated');
        expect((await sandbox.terminations()).at(-1)?.reason).toMatch(/origin is not opaque/i);
    });

    test("a message the page itself synthesises (untrusted), with the guest frame's window as its source, ends nothing: only the browser's own messages are taken", async ({ sandbox, page }) => {
        expect(await sandbox.mount({ mode: 'strict' })).toBe('ready');
        await page.evaluate(() => {
            // the guest frame is the wrapper's child (strict mode: the view)
            const wrapper = (document.querySelector('web-sandbox') as HTMLElement).shadowRoot!.querySelector('iframe')!;
            // the source is set on the event itself: Firefox does not take a cross-origin window in MessageEventInit
            const forged = new MessageEvent('message', { data: { type: 'ENVIRONMENT_REFUSED', refused: 'origin' } });
            Object.defineProperty(forged, 'source', { value: wrapper.contentWindow!.frames[0] });
            window.dispatchEvent(forged);
        });
        await page.waitForTimeout(300);
        expect(await sandbox.state()).toBe('ready');
        expect(await sandbox.terminations()).toEqual([]);
    });

    test('a row name that is not the table\'s ("constructor", "__proto__", "toString") from the guest\'s own window ends nothing and names no reason', async ({ sandbox, page }) => {
        const forged = ['constructor', '__proto__', 'toString', 'hasOwnProperty'].map(name => FORGE(name, 'parent.parent')).join('; ');
        expect(await sandbox.mount({ mode: 'cooperative', capabilities: ['allow-scripts'], html: `<p>x</p><script>${forged}<\/script>` })).toBe('ready');
        await page.waitForTimeout(500);
        expect(await sandbox.state()).toBe('ready');
        expect(await sandbox.terminations()).toEqual([]);
    });
});
