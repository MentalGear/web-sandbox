import { randomUUID } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import { test, expect, ORIGIN, OFFSITE_ORIGIN } from './fixture';
import { SERVED_FILE_PATH } from './served-file-server';
import { reasonText, type FixedReasonId } from '@src/lib/reasons';

/**
 * The start-up gates (design 03, "The start-up gates"; design 05, row 3.5; I15), on every engine, in the shipped static
 * file, each under the mutant that provokes it (research 31, Q2). Defence in depth after the construction: each mutant
 * stands for a browser that does not enforce what the file's policy, the view's `sandbox` attribute or the worker's
 * allowlist says, which is the one case the gates are for.
 *
 * A mutated file states the library's version still (served-file-server.ts), and is served from another origin that
 * does not allow the host page to read it, so the check of the file cannot refuse it first (design 03, "The check of the
 * file", which refuses such a copy where it can read it).
 *
 *  1. Each mutant ends the build with its gate's own reason, before the view is given anything: no `<meta>`, a weakened
 *     `script-src`, `connect-src`, `img-src`, `style-src` or `base-uri`, a view that is not opaque; and in the worker, a
 *     network name the allowlist left, where no call reaches the worker and its entry never runs.
 *  2. The library's file is never refused, over many starts per engine, and dispatches no violation of its canaries.
 *  3. No canary reaches the network: the only requests of a start, the library's file included, are the page's own and
 *     the file's, under a mutant that admits every canary too.
 */

interface Outcome { outcome: 'ready' | 'terminated'; reason: string | null }

function session() {
    const id = randomUUID();
    return {
        file: (query: Record<string, string | string[]> = {}, origin = OFFSITE_ORIGIN) => {
            const search = new URLSearchParams({ variant: 'library' });
            for (const [name, value] of Object.entries(query)) for (const one of [value].flat()) search.append(name, one);
            return `${origin}${SERVED_FILE_PATH}/${id}/file/sealed-document.html?${search}`;
        },
        page: (doc: string, extra: Record<string, string> = {}) => `${ORIGIN}${SERVED_FILE_PATH}/${id}/page?${new URLSearchParams({ doc, ...extra })}`,
    };
}

async function startAt(page: Page, url: string): Promise<Outcome> {
    await page.goto(url);
    await page.waitForFunction(() => (window as any).harnessReady === true);
    return page.evaluate(async () => { const { outcome, reason } = await (window as any).startSandbox(); return { outcome, reason }; });
}

test.describe('1. each gate under the mutant that provokes it ends the build with its own reason', () => {
    const cases: [string, Record<string, string | string[]>, FixedReasonId][] = [
        ['no <meta>: the first gate that sees it is code from strings', { meta: 'none' }, 'gateStringCode'],
        ["'unsafe-eval' in script-src", { add: "script-src:'unsafe-eval'" }, 'gateStringCode'],
        ['connect-src * data: blob:', { set: 'connect-src:* data: blob:' }, 'gateConnect'],
        ['img-src * data: blob:', { set: 'img-src:* data: blob:' }, 'gateImage'],
        ["style-src 'unsafe-inline' blob:", { set: "style-src:'unsafe-inline' blob:" }, 'gateStyle'],
        ['base-uri *', { set: 'base-uri:*' }, 'gateBase'],
    ];
    for (const [name, query, reason] of cases) {
        test(name, async ({ page }) => {
            const server = session();
            expect(await startAt(page, server.page(server.file(query)))).toEqual({ outcome: 'terminated', reason: reasonText(reason) });
        });
    }

    // the view's own origin is the environment check's (environment-check.ts, `origin`), which runs before the gates
    test('a view that is not opaque: its sandbox attribute with allow-same-origin, in a copy without its guard, framed without sandbox: the environment check ends it first', async ({ page }) => {
        const server = session();
        expect(await startAt(page, server.page(server.file({ viewSameOrigin: '1' }), { unsandboxed: '1' }))).toEqual({ outcome: 'terminated', reason: reasonText('environmentOrigin') });
    });

    test('the worker: a name the allowlist left (fetch, put back) ends the build; no call reaches the worker, and its entry never ran', async ({ page }) => {
        const server = session();
        await page.goto(server.page(server.file(), { mutant: 'networkName' }));
        await page.waitForFunction(() => (window as any).harnessReady === true);
        const result = await page.evaluate(() => (window as any).startWithCall());
        expect(result).toEqual({ outcome: 'terminated', reason: reasonText('gateAllowlist'), call: 'rejected TERMINATED', lines: [] });
        // the positive control: the same app, without the mutant, runs its entry and answers the call
        const clean = session();
        await page.goto(clean.page(clean.file()));
        await page.waitForFunction(() => (window as any).harnessReady === true);
        const control = await page.evaluate(() => (window as any).startWithCall());
        expect([control.outcome, control.call, control.lines.includes('the entry ran')]).toEqual(['ready', 'answered pong', true]);
    });
});

test.describe('2. the library\'s file is never refused, and its canaries are never reported', () => {
    test('100 starts, each a new element, are ready; the element dispatches no violation', async ({ page }) => {
        test.setTimeout(240_000);
        const server = session();
        await page.goto(server.page(server.file({}, ORIGIN)));
        await page.waitForFunction(() => (window as any).harnessReady === true);
        const outcomes = await page.evaluate(async () => {
            const seen: string[] = [];
            let violations = 0;
            document.addEventListener('violation', () => { violations++; }, true);
            for (let i = 0; i < 100; i++) {
                const { outcome, reason } = await (window as any).startSandbox();
                seen.push(reason ?? outcome);
                await new Promise(resolve => setTimeout(resolve, 50)); // its canaries' events, if one were reported
                document.querySelector('web-sandbox')!.remove();
            }
            return { seen: [...new Set(seen)], violations };
        });
        expect(outcomes).toEqual({ seen: ['ready'], violations: 0 });
    });
});

test.describe('3. no canary reaches the network', () => {
    test('the requests of a start are the page\'s and the file\'s alone, with the library\'s file and under a mutant that admits every canary', async ({ page, context }) => {
        const requests: string[] = [];
        const record = (request: Request) => requests.push(request.url());
        context.on('request', record);
        const server = session();
        expect(await startAt(page, server.page(server.file()))).toEqual({ outcome: 'ready', reason: null });
        const admitted = session();
        const outcome = await startAt(page, admitted.page(admitted.file({ meta: 'none' })));
        expect(outcome.outcome).toBe('terminated');
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
        context.off('request', record);
        const foreign = requests.filter(url => !url.startsWith(ORIGIN) && !url.startsWith(OFFSITE_ORIGIN) && !url.startsWith('blob:') && !url.startsWith('data:'));
        expect(foreign).toEqual([]);
        expect(requests.filter(url => url.includes('gate.invalid'))).toEqual([]);
        // and of the e2e server: the file, and the page with its scripts, nothing a canary names
        expect(requests.filter(url => url.startsWith(OFFSITE_ORIGIN) && !url.includes('/file/sealed-document.html'))).toEqual([]);
    });
});
