import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Frame, Page } from '@playwright/test';
import { test, expect, ORIGIN, OFFSITE_ORIGIN } from './fixture';
import { SERVED_FILE_PATH } from './served-file-server';
import { servedFilePolicy } from './served-file';
import { reasonText, type FixedReasonId } from '@src/lib/reasons';
import { CANARY_DOMAIN, canaryUrl } from '@src/lib/policy-check';

/**
 * The policy check of the served file (design 03, "The policies in force" and "What the policy check provokes"; design
 * 05, row 3.6; I18), on every engine, in the shipped static file, under policies on the file's own response. The file is
 * served from another origin that does not allow the host page to read it, so the check of the file cannot name the
 * header first (served-file-check.spec.ts is that check's), and what ends the build is the view's own check.
 *
 * Every header names a report endpoint of the test server's (`report-uri`), which records what each browser sends; the
 * host page's URL carries a secret in its query, and the app carries one (MARK) in its markup, its files' names, its
 * rendered text and the URLs it renders. No report may carry either (I18).
 *
 *  1. Each kind of load the view makes (VIEW_LOAD_KINDS: style, image, font, media, track), under a header that refuses
 *     the `<meta>`'s admitted load (`'self'`) and one at the `<meta>`'s own value (`blob:`), each enforced and
 *     report-only, ends the build with the reason that names the header's kind; so does every header research 31 found
 *     the check to see; a header it does not look for, or that refuses nothing, leaves a working sandbox.
 *  2. A guest's font, media, frame, object and form, under each of the five directives the renderer's rules close, at a
 *     value the check cannot see: no report carries guest text.
 *  3. A violation of another policy after the build is ready ends it, whenever it comes.
 *  4. The library's file is never refused, over many starts per engine with the machine loaded, and none of the
 *     canaries' violations is reported as the guest's; the check's cost, from insertion to `ready`.
 *  5. No canary reaches the network.
 */

const MARK = 'GUEST-SECRET';
const PAGE_SECRET = 'HOST-PAGE-SECRET';
// MARK as a host name holds it (a report of a frame's or an object's load names its origin alone)
const HOST_MARK = MARK.toLowerCase();

interface Outcome { outcome: 'ready' | 'terminated'; reason: string | null; ms: number }

/** A session of the file's server: the file on another origin that allows no read, with the headers a test puts on it. */
function session() {
    const id = randomUUID();
    const base = `${ORIGIN}${SERVED_FILE_PATH}/${id}`;
    const report = `${base}/report`;
    return {
        report,
        file: (headers: Record<string, string> = {}, variant = 'library') => {
            const search = new URLSearchParams({ variant });
            for (const [name, value] of Object.entries(headers)) search.append('h', `${name}:${value}`);
            return `${OFFSITE_ORIGIN}${SERVED_FILE_PATH}/${id}/file/sealed-document.html?${search}`;
        },
        page: (doc: string) => `${base}/page?${new URLSearchParams({ doc, secret: PAGE_SECRET })}`,
        reports: async (): Promise<unknown[]> => (await fetch(`${base}/reports`)).json() as Promise<unknown[]>,
    };
}

const ENFORCED = 'content-security-policy';
const REPORT_ONLY = 'content-security-policy-report-only';
type Kind = typeof ENFORCED | typeof REPORT_ONLY;
const REASON_OF: Record<Kind, FixedReasonId> = { [ENFORCED]: 'viewCsp', [REPORT_ONLY]: 'viewCspReportOnly' };

async function open(page: Page, url: string) {
    await page.goto(url);
    await page.waitForFunction(() => (window as any).harnessReady === true);
}

/** A 1×1 PNG, as a registered file of the guest's. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * The guest app of part 1: a load of each kind the view makes, from files whose names carry MARK, and markup, text and
 * style of its own that carry it; its entry renders more.
 */
async function startGuestApp(page: Page): Promise<Outcome> {
    return page.evaluate(async ({ mark, png }) => {
        const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
        const app = {
            html: `<p id="hello" title="${mark}-title">${mark}-html</p><img src="${mark}-image.png"><link rel="stylesheet" href="${mark}-style.css"><audio src="${mark}-media.wav"></audio><video><track src="${mark}-track.vtt"></video>`,
            entry: 'entry.js',
            files: {
                'entry.js': `sandboxView.render('<p style="color: red">${mark}-render</p><style>p { background: url(${mark}-image.png) } @font-face { font-family: g; src: url(${mark}-font.woff2) } p { font-family: g }</style>');`,
                [`${mark}-image.png`]: bytes,
                [`${mark}-style.css`]: `body { color: blue } /* ${mark}-css */`,
                [`${mark}-font.woff2`]: { content: 'wOF2', type: 'font/woff2' },
                [`${mark}-media.wav`]: { content: 'RIFF', type: 'audio/wav' },
                [`${mark}-track.vtt`]: { content: `WEBVTT\n\n00:00.000 --> 00:01.000\n${mark}-cue\n`, type: 'text/vtt' },
            },
        };
        const { outcome, reason, ms } = await (window as any).startSandbox(app);
        return { outcome, reason, ms };
    }, { mark: MARK, png: PNG });
}

/** What the reports carry that is not the library's: MARK or the host page's secret, anywhere in a report. */
async function leaks(server: ReturnType<typeof session>, page: Page): Promise<{ guest: unknown[]; host: unknown[]; count: number }> {
    await page.waitForTimeout(1500); // a report is sent once the refusal happened: give the browser time to send them all
    const reports = await server.reports();
    const text = (report: unknown) => JSON.stringify(report);
    return { guest: reports.filter(report => text(report).toLowerCase().includes(HOST_MARK)), host: reports.filter(report => text(report).includes(PAGE_SECRET)), count: reports.length };
}

// ---- 1 -----------------------------------------------------------------------------------------------------------------

/** The directive of each kind of load the view makes (VIEW_LOAD_KINDS). */
const LOAD_DIRECTIVES = { style: 'style-src', image: 'img-src', font: 'font-src', media: 'media-src', track: 'media-src' } as const;

interface HeaderCase {
    readonly value: string;
    readonly kinds: readonly Kind[];
    /** The outcome where it is not the kind's reason: a header the check does not look for, or one that stops the view. */
    readonly outcome?: { readonly outcome: 'ready' } | { readonly outcome: 'terminated'; readonly reason: FixedReasonId };
    /** No `report-uri` is added (a header that must keep its text). */
    readonly bare?: true;
    readonly note?: string;
}

const BOTH: readonly Kind[] = [ENFORCED, REPORT_ONLY];
// one directive can govern two kinds (media and track): its cases are the directive's
const LOAD_DIRECTIVE_NAMES = [...new Set<string>(Object.values(LOAD_DIRECTIVES))];
const HEADERS: readonly HeaderCase[] = [
    ...LOAD_DIRECTIVE_NAMES.flatMap(directive => [
        { value: `${directive} 'self'`, kinds: BOTH, note: `${directive}: refuses the <meta>'s admitted blob: load` },
        { value: `${directive} blob:`, kinds: BOTH, note: `${directive}: the <meta>'s own value, which only the refused canaries see` },
    ]),
    { value: "default-src 'self'", kinds: [REPORT_ONLY], note: "research 31's site-wide header" },
    { value: "default-src 'self'", kinds: [ENFORCED], outcome: { outcome: 'terminated', reason: 'documentSilent' }, note: "it refuses the file's guard and the view's bootstrap: no view runs" },
    { value: "script-src 'self'", kinds: [REPORT_ONLY] },
    { value: "connect-src 'self'", kinds: BOTH },
    { value: "worker-src 'self'", kinds: BOTH, note: 'the canary worker' },
    { value: 'worker-src blob:', kinds: BOTH, note: 'the data: worker' },
    { value: "frame-src 'none'", kinds: BOTH },
    { value: "object-src 'none'", kinds: BOTH },
    { value: "base-uri 'none'", kinds: [REPORT_ONLY] },
    { value: "base-uri 'none'", kinds: [ENFORCED], outcome: { outcome: 'terminated', reason: 'environmentBase' }, note: "it refuses the file's own <base>, so the view's base URL is not about:blank, which its environment check refuses first" },
    { value: 'font-src https: blob:', kinds: BOTH, note: 'the http: canary' },
    { value: "require-trusted-types-for 'script'", kinds: BOTH },
    { value: "img-src * blob:; style-src * blob: 'unsafe-inline'; font-src *", kinds: BOTH, note: 'admits more than the <meta> for two kinds and refuses a blob: font: the admitted canary' },
    { value: 'upgrade-insecure-requests', kinds: [ENFORCED], outcome: { outcome: 'ready' }, bare: true, note: 'refuses nothing; it upgrades the http: canaries, which their hosts still name' },
    { value: 'sandbox allow-scripts allow-forms', kinds: [ENFORCED], outcome: { outcome: 'ready' }, bare: true, note: 'a header sandbox: the file is sandboxed already' },
];

test.describe('1. a policy on the file\'s response ends the build with the reason that names its kind, and no report carries guest text', () => {
    for (const header of HEADERS) {
        for (const kind of header.kinds) {
            const value = header.bare ? header.value : `${header.value}; report-uri ${'REPORT'}`;
            test(`${kind}: ${header.value}`, async ({ page, browserName }) => {
                const server = session();
                await open(page, server.page(server.file({ [kind]: value.replace('REPORT', server.report) })));
                const result = await startGuestApp(page);
                const expected = header.outcome ?? { outcome: 'terminated', reason: REASON_OF[kind] };
                expect({ outcome: result.outcome, reason: result.reason }, header.note).toEqual({ outcome: expected.outcome, reason: 'reason' in expected ? reasonText(expected.reason) : null });
                const found = await leaks(server, page);
                expect(found.guest, 'no report carries guest text').toEqual([]);
                expect(found.host, "no report carries the host page's URL").toEqual([]);
                // the endpoint works: the canaries' own refusals reached it (WebKit sends none from an opaque document)
                // ledger: opaque-reports
                if (kind === REPORT_ONLY && header.value === "default-src 'self'" && browserName !== 'webkit') expect(found.count).toBeGreaterThan(0);
            });
        }
    }

    // The check does not look for this one (design 03: it names no endpoint, so nothing is sent under it); as a header it
    // binds the file's own document from its first byte, so it refuses the file's <base>, which precedes the <meta>, and
    // the view's environment check ends the build first.
    test("the <meta>'s exact text, enforced: it refuses the file's own <base>, and the environment check ends the build", async ({ page }) => {
        const server = session();
        await open(page, server.page(server.file({ [ENFORCED]: servedFilePolicy() })));
        expect((await startGuestApp(page)).reason).toBe(reasonText('environmentBase'));
    });

    test("the <meta>'s exact text, report-only, is seen by its disposition", async ({ page }) => {
        const server = session();
        await open(page, server.page(server.file({ [REPORT_ONLY]: servedFilePolicy() })));
        expect((await startGuestApp(page)).reason).toBe(reasonText('viewCspReportOnly'));
    });
});

// ---- 2 -----------------------------------------------------------------------------------------------------------------

/** The guest of part 2: a font, media, a frame, an object and a form, each to a URL of its own that carries MARK. */
const RENDERER_GUEST = `sandboxView.render('<style>@font-face { font-family: g; src: url(http://${HOST_MARK}-font.invalid/${MARK}-font) } p { font-family: g }</style>`
    + `<p>${MARK}</p><audio src="http://${HOST_MARK}-media.invalid/${MARK}-media" preload="auto"></audio>`
    + `<video preload="auto"><source src="https://${HOST_MARK}-source.invalid/${MARK}-source"></video>`
    + `<iframe src="http://${HOST_MARK}-frame.invalid/${MARK}-frame"></iframe><object data="http://${HOST_MARK}-object.invalid/${MARK}-object"></object>`
    + `<form action="http://${HOST_MARK}-form.invalid/${MARK}-form" method="get"><input name="q" value="${MARK}"><button id="go">go</button></form>');`;

/** The view's frame: the first frame of the element's frame. */
const viewFrame = (page: Page): Frame | undefined => page.frames().find(frame => !frame.isDetached() && frame.parentFrame()?.parentFrame() === page.mainFrame());
/** The buttons the guest rendered in the view, read wherever the view's frame is now (0 while it is not there yet). */
const renderedButtons = async (page: Page): Promise<number> => {
    const frame = viewFrame(page);
    return frame ? frame.locator('button').count().catch(() => 0) : 0;
};

/**
 * The five directives the renderer's rules close (design 03, the table under "What is left unseen"), each at a value
 * the check's canaries pass: one that names the canaries' reserved host, and every `form-action`. WebKit refused the
 * canaries under the first kind (research 31, Q6), so its check sees those and ends the build.
 */
const UNSEEN = [
    // ledger: policy-canary-host
    { value: `font-src *.${CANARY_DOMAIN} blob:`, seenOn: ['webkit'] },
    { value: `media-src *.${CANARY_DOMAIN} blob:`, seenOn: ['webkit'] }, // ledger: policy-canary-host
    { value: `frame-src *.${CANARY_DOMAIN}`, seenOn: ['webkit'] }, // ledger: policy-canary-host
    { value: `object-src *.${CANARY_DOMAIN}`, seenOn: ['webkit'] }, // ledger: policy-canary-host
    { value: "form-action 'none'", seenOn: [] },
] as const;

test.describe("2. under the five directives the renderer's rules close, a guest's font, media, frame, object and form give no report that carries guest text", () => {
    for (const header of UNSEEN) {
        for (const kind of BOTH) {
            test(`${kind}: ${header.value}`, async ({ page, browserName }) => {
                const server = session();
                await open(page, server.page(server.file({ [kind]: `${header.value}; report-uri ${server.report}` })));
                const result = await page.evaluate(async (entry) => {
                    const { outcome, reason } = await (window as any).startSandbox({ entry: 'entry.js', files: { 'entry.js': entry } });
                    return { outcome, reason };
                }, RENDERER_GUEST);
                // ledger: policy-canary-host
                const seen = (header.seenOn as readonly string[]).includes(browserName);
                expect(result, seen ? 'this engine refuses the canaries under it: the check sees it' : 'the check cannot see it').toEqual(seen ? { outcome: 'terminated', reason: reasonText(REASON_OF[kind]) } : { outcome: 'ready', reason: null });
                if (!seen) {
                    // The guest renders and the user clicks its submit button. The build may end before, or soon after: a
                    // later violation of the header's ends it whenever it comes, which the check is for. A form is never
                    // refused, so under form-action the click is always made.
                    const rendered = await expect.poll(() => renderedButtons(page), { timeout: 5000 }).toBe(1).then(() => true, () => false);
                    if (header.value.startsWith('form-action')) expect(rendered, 'the guest rendered').toBe(true);
                    if (rendered) await viewFrame(page)?.locator('button').click({ timeout: 2000 }).catch(() => undefined); // the user's own click
                }
                const found = await leaks(server, page);
                expect(found.guest, 'no report carries guest text').toEqual([]);
                expect(found.host).toEqual([]);
                const end = await page.evaluate(() => (window as any).lastEnd);
                expect(seen ? [reasonText(REASON_OF[kind])] : [null, reasonText(REASON_OF[kind])]).toContain(end);
            });
        }
    }
});

// ---- 3 -----------------------------------------------------------------------------------------------------------------

test.describe('3. a violation of another policy after the build is ready ends it', () => {
    // A header the check passes (it names the canaries' host for frames); then a frame load in the view that the header
    // refuses, which the view's own code never makes: it stands for a violation the check did not provoke, coming late.
    for (const kind of BOTH) {
        test(`${kind}: a refused frame load once ready ends the build with ${REASON_OF[kind]}`, async ({ page, browserName }) => {
            const server = session();
            await open(page, server.page(server.file({ [kind]: `frame-src *.${CANARY_DOMAIN}; report-uri ${server.report}` })));
            const first = await page.evaluate(async () => {
                const { outcome, reason } = await (window as any).startSandbox();
                return { outcome, reason };
            });
            // ledger: policy-canary-host
            if (browserName === 'webkit') {
                expect(first, 'WebKit refuses the canaries under it: the check sees it at the start').toEqual({ outcome: 'terminated', reason: reasonText(REASON_OF[kind]) });
                return;
            }
            expect(first).toEqual({ outcome: 'ready', reason: null });
            await viewFrame(page)!.evaluate(() => {
                const frame = document.createElement('iframe');
                frame.src = 'http://late.invalid/';
                document.body.append(frame);
            });
            await expect.poll(() => page.evaluate(() => (window as any).lastEnd), { message: 'the build ends, after its ready' }).toBe(reasonText(REASON_OF[kind]));
            expect(await page.evaluate(() => (document.querySelector('web-sandbox') as any).state)).toBe('terminated');
        });
    }
});

// ---- 4 -----------------------------------------------------------------------------------------------------------------

/** Busy processes that load the machine's cores while they run (research 31, Q8's loaded phase). */
function loadMachine(count: number): () => void {
    const busy: ChildProcess[] = [];
    for (let i = 0; i < count; i++) busy.push(spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
    return () => { for (const child of busy) child.kill('SIGKILL'); };
}

test.describe('4. the library\'s file is never refused, on a loaded machine, and its canaries are never reported', () => {
    test('200 starts, each a new element, with three cores busy, are ready; the element dispatches no violation; the check\'s cost', async ({ page, browserName }) => {
        test.setTimeout(600_000);
        const server = session();
        const checked = server.file();
        const unchecked = server.file({}, 'noCheck');
        // the file whose check provokes nothing has no canary in it (served-file-server.ts, `noCheck`)
        expect([(await (await fetch(checked)).text()).includes(CANARY_DOMAIN), (await (await fetch(unchecked)).text()).includes(CANARY_DOMAIN)]).toEqual([true, false]);
        await open(page, server.page(checked));
        const unload = loadMachine(3);
        try {
            const run = await page.evaluate(async () => {
                const seen: string[] = [];
                const times: number[] = [];
                let violations = 0;
                document.addEventListener('violation', () => { violations++; }, true);
                for (let i = 0; i < 200; i++) {
                    const { outcome, reason, ms } = await (window as any).startSandbox();
                    seen.push(reason ?? outcome);
                    times.push(ms);
                    await new Promise(resolve => setTimeout(resolve, 30)); // its canaries' late events, if one were reported
                    document.querySelector('web-sandbox')!.remove();
                }
                return { seen: [...new Set(seen)], violations, times };
            });
            expect({ seen: run.seen, violations: run.violations }).toEqual({ seen: ['ready'], violations: 0 });
        } finally {
            unload();
        }
        // The cost: insertion to `ready`, the library's file against one whose check provokes nothing, alternating, each a
        // new page (the registration's kept check of the file does not apply: another origin, no read).
        const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
        const times: Record<'checked' | 'unchecked', number[]> = { checked: [], unchecked: [] };
        for (let i = 0; i < 24; i++) {
            for (const [name, doc] of [['checked', checked], ['unchecked', unchecked]] as const) {
                await open(page, server.page(doc));
                const result = await page.evaluate(async () => (window as any).startSandbox());
                expect(result.outcome, name).toBe('ready');
                times[name].push(result.ms);
            }
        }
        console.log(`MEASURED ${browserName} policy check, insertion to ready, median of 24 alternating (ms): with the check ${median(times.checked).toFixed(1)}, with a check that provokes nothing ${median(times.unchecked).toFixed(1)}`);
    });
});

// ---- 5 -----------------------------------------------------------------------------------------------------------------

test.describe('5. no canary reaches the network', () => {
    test("a start's requests that reach the network are the page's and the file's alone; a canary's URL fetched by the page itself is seen (the control)", async ({ page, context }) => {
        // What reaches the network is what the browser routes: a load a policy refused is never routed.
        const routed: string[] = [];
        await context.route('**/*', (route) => {
            routed.push(route.request().url());
            const url = route.request().url();
            return url.includes(CANARY_DOMAIN) ? route.abort() : route.continue();
        });
        const server = session();
        await open(page, server.page(server.file()));
        expect((await page.evaluate(async () => (window as any).startSandbox())).outcome).toBe('ready');
        await page.waitForTimeout(500);
        expect(routed.filter(url => url.includes(CANARY_DOMAIN))).toEqual([]);
        // (WebKit routes the view's own blob: loads as well; they are no network request)
        expect(routed.filter(url => !url.startsWith(ORIGIN) && !url.startsWith(OFFSITE_ORIGIN) && !url.startsWith('blob:'))).toEqual([]);
        const control = canaryUrl('connect', 'http');
        await page.evaluate((url) => fetch(url).catch(() => null), control);
        expect(routed).toContain(control);
    });
});
