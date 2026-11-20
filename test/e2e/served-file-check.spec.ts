import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, ORIGIN, OFFSITE_ORIGIN } from './fixture';
import { reasonText } from '@src/lib/reasons';
import { MISSING_DETAILS } from '@src/lib/document-check';
import { SERVED_FILE_PATH, type FileHit, type FileVariant } from './served-file-server';

/**
 * The check of the served file (design 03, "The check of the file"; design 05, row 3.3), on every engine: before sealed
 * mode's first frame of a registration the element requests `documentUrl` itself, and each finding ends the build with
 * its own reason before anything is framed. The file is served by test/e2e/served-file-server.ts, the ways a deployment
 * gets it wrong; the host page is test/e2e/served-file-page.ts, one registration per page load.
 *
 *  1. Each finding: no file (404, a type that is not HTML), another page, a modified file (a dev server's script ahead of
 *     the policy, a minified copy, no guard, a view that lost its sandbox), another version's file, and each refused
 *     header, enforced and report-only; the headers the file may carry pass.
 *  2. Where the answer cannot be read there is no check and the build runs: another origin without CORS, a host page
 *     whose connect-src refuses the request; with CORS the other origin's file is checked.
 *  3. The answer is kept for the registration: one request, however many builds; a finding refuses every later build.
 *  4. A check, for honest deployments: a server that answers the check and the frame otherwise, and a Service Worker
 *     that answers the check.
 *  5. What the request carries: no cookie, no referrer, no header of the app's from a wrapper installed after the
 *     library (one installed before it is inherited: INHERITED_CONTEXT, `hostRealmGlobals`).
 *  6. The correct file is never refused, over many starts.
 *  7. What it costs: start-up with the check and without it, cold and warm, and whether the frame reuses the response.
 */

interface Outcome { outcome: 'ready' | 'terminated'; reason: string | null; ms: number; framed: number }

/** A session of the server: its URLs, and what reached the file's path. */
function session(origin = ORIGIN) {
    const id = randomUUID();
    const base = `${origin}${SERVED_FILE_PATH}/${id}`;
    return {
        id,
        file: (variant: FileVariant = 'library', extra: Record<string, string | string[]> = {}) => {
            const query = new URLSearchParams({ variant });
            for (const [name, value] of Object.entries(extra)) for (const one of [value].flat()) query.append(name, one);
            return `${base}/file/sealed-document.html?${query}`;
        },
        page: (doc: string, extra: Record<string, string> = {}) => `${ORIGIN}${SERVED_FILE_PATH}/${id}/page?${new URLSearchParams({ doc, ...extra })}`,
        hits: async (): Promise<FileHit[]> => (await fetch(`${ORIGIN}${SERVED_FILE_PATH}/${id}/hits`)).json(),
    };
}

/** Opens the host page registering `doc`, and starts one sealed app there. */
async function startAt(page: Page, url: string): Promise<Outcome> {
    await page.goto(url);
    await page.waitForFunction(() => (window as any).harnessReady === true);
    return page.evaluate(() => (window as any).startSandbox());
}
const startAgain = (page: Page): Promise<Outcome> => page.evaluate(() => (window as any).startSandbox());

const changed = reasonText('documentChanged');

test.describe('1. each finding ends the build with its own reason, before anything is framed', () => {
    const cases: [string, FileVariant, Record<string, string | string[]>, string][] = [
        ['a 404', 'missing', {}, reasonText('documentMissing', MISSING_DETAILS.status)],
        ['a 200 that is not HTML (text/plain)', 'plain', {}, reasonText('documentMissing', MISSING_DETAILS.type)],
        ["another page at the URL (an app's fallback page)", 'fallback', {}, changed],
        ["a dev server's client script ahead of the policy tag", 'devClient', {}, changed],
        ['a minified copy', 'minified', {}, changed],
        ['a copy without the guard', 'noGuard', {}, changed],
        ['a copy whose inner frame lost its sandbox', 'noSandbox', {}, changed],
        ["another version's file", 'otherVersion', {}, changed],
        ['Content-Security-Policy', 'library', { h: "content-security-policy:default-src 'self'" }, reasonText('documentCsp')],
        ['Content-Security-Policy-Report-Only', 'library', { h: "content-security-policy-report-only:default-src 'self'; report-uri /r" }, reasonText('documentCspReportOnly')],
        ['X-Frame-Options: DENY', 'library', { h: 'x-frame-options:DENY' }, reasonText('documentFrameOptions')],
        ['X-Frame-Options: SAMEORIGIN', 'library', { h: 'x-frame-options:SAMEORIGIN' }, reasonText('documentFrameOptions')],
        ['frame-ancestors, enforced', 'library', { h: "content-security-policy:frame-ancestors 'none'" }, reasonText('documentFrameAncestors')],
        ['frame-ancestors, report-only', 'library', { h: "content-security-policy-report-only:frame-ancestors 'none'" }, reasonText('documentFrameAncestors')],
    ];
    for (const [name, variant, extra, reason] of cases) {
        test(name, async ({ page }) => {
            const server = session();
            const outcome = await startAt(page, server.page(server.file(variant, extra)));
            expect([outcome.outcome, outcome.reason, outcome.framed]).toEqual(['terminated', reason, 0]);
            // one request, the check's, and no navigation of a frame
            expect((await server.hits()).map(hit => hit.dest)).toEqual(['empty']);
        });
    }

    test('the library\'s file, and with the headers a file may carry (CORP, COEP, Permissions-Policy): ready', async ({ page }) => {
        const server = session();
        const carried: Record<string, string | string[]>[] = [{}, { h: ['cross-origin-resource-policy:same-origin', 'cross-origin-embedder-policy:require-corp', 'permissions-policy:camera=()'] }];
        for (const extra of carried) {
            const outcome = await startAt(page, server.page(server.file('library', extra)));
            expect([outcome.outcome, outcome.framed], JSON.stringify(extra)).toEqual(['ready', 1]);
        }
    });
});

test.describe('2. where the answer cannot be read there is no check, and the build runs', () => {
    test('another origin without CORS: no check (a fallback page there ends as "did not answer"); with CORS: checked', async ({ page }) => {
        const offsite = session(OFFSITE_ORIGIN);
        expect((await startAt(page, offsite.page(offsite.file('library')))).outcome).toBe('ready');
        const silent = await startAt(page, offsite.page(offsite.file('fallback')));
        expect([silent.outcome, silent.reason]).toEqual(['terminated', reasonText('documentSilent')]);
        // with CORS the answer can be read: the same fallback page is named, and the library's file runs
        const named = await startAt(page, offsite.page(offsite.file('fallback', { cors: '1' })));
        expect([named.outcome, named.reason, named.framed]).toEqual(['terminated', changed, 0]);
        expect((await startAt(page, offsite.page(offsite.file('library', { cors: '1' })))).outcome).toBe('ready');
    });

    test("a host page whose connect-src refuses the request: no check, the build runs, and the page sees one violation", async ({ page }) => {
        const server = session();
        const doc = server.file('library');
        const outcome = await startAt(page, server.page(doc, { csp: "connect-src 'none'" }));
        expect(outcome.outcome).toBe('ready');
        const violations: string[] = await page.evaluate(() => (window as any).pageViolations);
        expect(violations.filter(line => line.startsWith('connect-src'))).toHaveLength(1);
        // the frame's navigation reached the server; the check's request never did
        expect((await server.hits()).map(hit => hit.dest)).toEqual(['iframe']);
        // not an answer: the next build asks again (and is refused again)
        expect((await startAgain(page)).outcome).toBe('ready');
        expect(((await page.evaluate(() => (window as any).pageViolations)) as string[]).filter(line => line.startsWith('connect-src'))).toHaveLength(2);
    });
});

test.describe('3. the answer is kept for the registration', () => {
    test('the library\'s file: one request of the check for every build of every element of the page', async ({ page }) => {
        const server = session();
        expect((await startAt(page, server.page(server.file('library')))).outcome).toBe('ready');
        for (let i = 0; i < 3; i++) expect((await startAgain(page)).outcome).toBe('ready');
        const dests = (await server.hits()).map(hit => hit.dest);
        expect(dests.filter(dest => dest === 'empty')).toHaveLength(1);
        expect(dests.filter(dest => dest === 'iframe')).toHaveLength(4);
    });

    test('a finding: every later build is refused with it at once, with no request; a page that loads again asks again', async ({ page }) => {
        const server = session();
        const url = server.page(server.file('devClient'));
        expect((await startAt(page, url)).reason).toBe(changed);
        const again = await startAgain(page);
        expect([again.outcome, again.reason, again.framed]).toEqual(['terminated', changed, 0]);
        expect((await server.hits()).map(hit => hit.dest)).toEqual(['empty']);
        expect((await startAt(page, url)).reason).toBe(changed);
        expect((await server.hits()).map(hit => hit.dest)).toEqual(['empty', 'empty']);
    });
});

test.describe('4. a check, for honest deployments', () => {
    test('a server that answers the check and the frame otherwise (they differ in Sec-Fetch-Dest) is judged by what the check read', async ({ page }) => {
        const server = session();
        // the check reads the file and passes; the frame gets another page, which never answers
        const passed = await startAt(page, server.page(server.file('checkGetsFile')));
        expect([passed.outcome, passed.reason]).toEqual(['terminated', reasonText('documentSilent')]);
        // the check reads another page and refuses a frame that would have worked
        const refused = await startAt(page, server.page(server.file('frameGetsFile')));
        expect([refused.outcome, refused.reason, refused.framed]).toEqual(['terminated', changed, 0]);
        expect((await server.hits()).map(hit => `${hit.variant} ${hit.dest}`)).toEqual(['checkGetsFile empty', 'checkGetsFile iframe', 'frameGetsFile empty']);
    });

    test("a Service Worker of the host page's that answers the check's request: its answer is what is checked", async ({ page }) => {
        const server = session();
        const outcome = await startAt(page, server.page(server.file('library', { sw: 'answer' }), { sw: '1' }));
        expect(await page.evaluate(() => (window as any).controlled)).toBe(true);
        expect([outcome.outcome, outcome.reason, outcome.framed]).toEqual(['terminated', changed, 0]);
        expect(await server.hits()).toEqual([]); // the Service Worker answered: nothing reached the server
        // a request it does not answer goes to the network, and the file passes
        const other = session();
        expect((await startAt(page, other.page(other.file('library'), { sw: '1' }))).outcome).toBe('ready');
    });
});

test.describe('5. what the request carries', () => {
    test("no cookie, no referrer, the Accept of a navigation; an app's fetch wrapper installed after the library does not see it, one installed before does", async ({ page, context }) => {
        await context.addCookies([{ name: 'host_session', value: 'USER-COOKIE', url: ORIGIN, sameSite: 'Lax' }]);
        const after = session();
        expect((await startAt(page, after.page(after.file('library'), { wrap: 'after' }))).outcome).toBe('ready');
        const check = (await after.hits()).find(hit => hit.dest === 'empty')!;
        expect([check.cookie, check.authorization, check.referer, check.accept]).toEqual([null, null, null, 'text/html']);
        // a wrapper the page installed before the library was loaded is the platform's fetch as far as the library can tell
        const before = session();
        expect((await startAt(page, before.page(before.file('library'), { wrap: 'before' }))).outcome).toBe('ready');
        const wrapped = (await before.hits()).find(hit => hit.dest === 'empty')!;
        expect([wrapped.cookie, wrapped.authorization, wrapped.referer]).toEqual([null, 'Bearer APP-USER-TOKEN', null]);
    });
});

test.describe('6. the correct file is never refused', () => {
    test('40 first builds, each in a page of its own, are ready', async ({ page }) => {
        const outcomes: string[] = [];
        for (let i = 0; i < 40; i++) {
            const server = session();
            const outcome = await startAt(page, server.page(server.file('library')));
            outcomes.push(outcome.outcome === 'ready' ? 'ready' : `${outcome.outcome}: ${outcome.reason}`);
        }
        expect(outcomes.filter(outcome => outcome !== 'ready')).toEqual([]);
    });
});

test.describe('7. what it costs', () => {
    test('start-up with the check and without it, cold and warm, and whether the frame reuses the check\'s response', async ({ page, browserName }) => {
        const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
        const runs = { checkedCold: [] as number[], checkedWarm: [] as number[], kept: [] as number[] };
        const reuse: number[] = [];
        // warm: one cacheable URL for every page of the run, loaded once before
        const warm = session();
        const warmFile = warm.file('library', { cache: '1' });
        expect((await startAt(page, warm.page(warmFile))).outcome).toBe('ready');
        for (let i = 0; i < 12; i++) {
            const cold = session();
            const first = await startAt(page, cold.page(cold.file('library', { cache: '1' })));
            reuse.push((await cold.hits()).length); // 2: the frame made its own request; 1: it reused the check's response
            const second = await startAgain(page); // the same registration: the kept answer, no check
            expect([first.outcome, second.outcome]).toEqual(['ready', 'ready']);
            runs.checkedCold.push(first.ms);
            runs.kept.push(second.ms);
            const warmed = await startAt(page, warm.page(warmFile));
            expect(warmed.outcome).toBe('ready');
            runs.checkedWarm.push(warmed.ms);
        }
        const summary = { checkedCold: median(runs.checkedCold), checkedWarm: median(runs.checkedWarm), kept: median(runs.kept) };
        console.log(`MEASURED ${browserName} served-file check, insertion to ready, median of 12 (ms): first build cold ${summary.checkedCold.toFixed(1)}, first build warm ${summary.checkedWarm.toFixed(1)}, a later build (kept, no check) ${summary.kept.toFixed(1)}; requests at the server for a first build with a cacheable file: ${JSON.stringify(reuse)}`);
        for (const value of Object.values(summary)) expect(value).toBeLessThan(5000);
    });
});
