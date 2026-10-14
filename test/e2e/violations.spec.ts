import { test, expect } from './fixture';

/**
 * Backlog S5: CSP violations in the guest reach the host as a 'violation' event on the element.
 * Guarantees:
 *   1. a load the guest policy refuses is reported on the host, with a minimal validated detail; the event
 *      bubbles, and event.target names the sandbox;
 *   2. the listener is installed before any guest code runs: a violation raised while the guest markup is
 *      parsed is reported, and a guest listener registered later cannot keep ours from seeing one;
 *   3. a report is a guest claim, never a host fact: synthetic events are not forwarded, a frame forged on
 *      the port is validated and clamped, and the number of events per environment is capped;
 *   4. worker mode forwards what the engine raises in the worker (measured per engine below);
 *   5. strict mode (ADR-005, A6): the host labels each report by the port it arrived on, never by what the
 *      frame says. 'view' reports come from the view document, which runs no guest code, so they are the
 *      library's own and complete up to the cap, which is per port: a worker flooding its own (logic)
 *      port cannot use up the view's. 'logic' reports are the worker's, per engine as in 4.
 */

const ATTACKER = 'https://attacker.test';

test.describe('1. a refused load is reported on the host', () => {
    test('image and fetch: one event each, with directive, blockedURI and source position; it bubbles to window with the element as target', async ({ sandbox, page }) => {
        expect(await sandbox.mount()).toBe('ready');
        const outcome = await sandbox.inGuest(`
            const img = await new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('refused'); i.src = '${ATTACKER}/img'; });
            const fetched = await fetch('${ATTACKER}/fetch', { mode: 'no-cors' }).then(() => 'reached', () => 'refused');
            return { img, fetched };
        `);
        expect(outcome).toEqual({ img: 'refused', fetched: 'refused' });

        const img = await sandbox.waitForViolation('img-src', `${ATTACKER}/img`);
        const fetched = await sandbox.waitForViolation('connect-src', `${ATTACKER}/fetch`);
        expect(img).toMatchObject({ sandbox: 'main', blockedURI: `${ATTACKER}/img` });
        expect(fetched).toMatchObject({ sandbox: 'main', blockedURI: `${ATTACKER}/fetch` });
        // only the documented fields, each of its documented type
        for (const record of [img, fetched]) {
            const { sandbox: _, ...detail } = record;
            for (const key of Object.keys(detail)) expect(['directive', 'blockedURI', 'sourceFile', 'lineNumber', 'columnNumber']).toContain(key);
            if (detail.lineNumber !== undefined) expect(detail.lineNumber).toBeGreaterThan(0);
        }

        // dispatched on the element itself, bubbling (the harness hears it on window)
        const onElement = await page.evaluate(() => new Promise<{ bubbles: boolean; isElement: boolean; directive: string }>(resolve => {
            const el = document.querySelector('web-sandbox')!;
            el.addEventListener('violation', (e) => resolve({ bubbles: e.bubbles, isElement: e.target === el, directive: (e as CustomEvent).detail.directive }), { once: true });
            (el as any).execute(`new Image().src = 'https://attacker.test/again'`);
        }));
        expect(onElement).toEqual({ bubbles: true, isElement: true, directive: 'img-src' });
    });

    test('a second sandbox reports its own violations, told apart by event.target', async ({ sandbox }) => {
        expect(await sandbox.mount()).toBe('ready');
        expect(await sandbox.mountSecond({ html: `<img src="${ATTACKER}/second">` })).toBe('ready');
        const second = await sandbox.waitForViolation('img-src', `${ATTACKER}/second`);
        expect(second.sandbox).toBe('second');
    });
});

test.describe('2. installed before any guest code runs', () => {
    test('a violation raised while the guest markup is parsed, before the port exists, is reported', async ({ sandbox }) => {
        expect(await sandbox.mount({ scriptUnsafe: false, html: `<img src="${ATTACKER}/during-parse">` })).toBe('ready');
        expect(await sandbox.waitForViolation('img-src', `${ATTACKER}/during-parse`)).toBeTruthy();
    });

    test('guest listeners that stop propagation, on window and document in both phases, cannot keep it from being reported', async ({ sandbox }) => {
        expect(await sandbox.mount({ scriptUnsafe: false, html: `<script>
            const stop = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };
            for (const target of [window, document]) { target.addEventListener('securitypolicyviolation', stop, true); target.addEventListener('securitypolicyviolation', stop); }
            new Image().src = '${ATTACKER}/suppressed';
        </script>` })).toBe('ready');
        expect(await sandbox.waitForViolation('img-src', `${ATTACKER}/suppressed`)).toBeTruthy();
    });
});

test.describe('3. a report is a guest claim', () => {
    test('a synthetic securitypolicyviolation event dispatched by guest code is not forwarded; a real one after it is (positive control)', async ({ sandbox }) => {
        expect(await sandbox.mount()).toBe('ready');
        await sandbox.run(`
            dispatchEvent(new SecurityPolicyViolationEvent('securitypolicyviolation', { effectiveDirective: 'img-src', violatedDirective: 'img-src', blockedURI: 'https://forged.test/', originalPolicy: '', disposition: 'enforce', statusCode: 0 }));
            new Image().src = '${ATTACKER}/real';
        `);
        await sandbox.waitForViolation('img-src', `${ATTACKER}/real`);
        expect((await sandbox.violations()).map(v => v.blockedURI)).toEqual([`${ATTACKER}/real`]);
    });

    test('a frame the guest forges on the port is validated and clamped: a bad directive is dropped, long strings are cut, extra fields never reach the host', async ({ sandbox }) => {
        expect(await sandbox.mount()).toBe('ready');
        // Guest code can reach the port by patching MessagePort.prototype.postMessage before the bootstrap's
        // next post (here: its console relay). This is why a report is never a host fact.
        await sandbox.run(`
            const original = MessagePort.prototype.postMessage;
            MessagePort.prototype.postMessage = function (message, ...rest) {
                MessagePort.prototype.postMessage = original;
                this.postMessage({ type: 'VIOLATION', directive: 'img-src; script-src *', blockedURI: 'x' });
                this.postMessage({ type: 'VIOLATION', directive: 'connect-src', blockedURI: 'y'.repeat(10000), lineNumber: -4, hostFact: true });
                this.postMessage({ type: 'VIOLATION', directive: 'connect-src', blockedURI: 'FORGED_DONE' });
                return original.call(this, message, ...rest);
            };
            console.log('trigger');
        `);
        await sandbox.waitForViolation('connect-src', 'FORGED_DONE');
        const forged = await sandbox.violations();
        expect(forged.map(v => [v.directive, v.blockedURI.length])).toEqual([['connect-src', 2048], ['connect-src', 'FORGED_DONE'.length]]);
        expect(forged[0]).toEqual({ sandbox: 'main', directive: 'connect-src', blockedURI: 'y'.repeat(2048) });
    });

    test('an honest guest stops forwarding at 100 per environment, below the host cap that warns; the next environment starts a fresh count', async ({ sandbox, page }) => {
        const warnings: string[] = [];
        page.on('console', m => { if (m.type() === 'warning' && m.text().includes('CSP violations')) warnings.push(m.text()); });
        expect(await sandbox.mount()).toBe('ready');
        await sandbox.run(`for (let i = 0; i < 150; i++) new Image().src = '${ATTACKER}/flood/' + i;`);
        await sandbox.waitForViolation('img-src', `${ATTACKER}/flood/99`);
        await page.waitForTimeout(500); // anything past the cap would have arrived by now
        expect(await sandbox.violations()).toHaveLength(100);

        expect(await sandbox.reset()).toBe('ready');
        await sandbox.run(`new Image().src = '${ATTACKER}/after-reset'`);
        await sandbox.waitForViolation('img-src', `${ATTACKER}/after-reset`);
        expect(await sandbox.violations()).toHaveLength(101);
        // the guest stops forwarding at the same number, so the host's cap is reached but never exceeded
        // by an honest guest: no warning here. A forged flood past it warns once (unit: test/unit/host.test.ts).
        expect(warnings).toEqual([]);
    });
});

test.describe('4. worker mode', () => {
    test('reports what the engine raises in the worker: measured per engine', async ({ sandbox, browserName }) => {
        expect(await sandbox.mount({ mode: 'worker' })).toBe('ready');
        const outcome = await sandbox.inGuest(`
            const fetched = await fetch('${ATTACKER}/worker-fetch', { mode: 'no-cors' }).then(() => 'reached', () => 'refused');
            let imported;
            try { importScripts('${ATTACKER}/worker-import.js'); imported = 'reached'; } catch (e) { imported = 'refused'; }
            return { fetched, imported };
        `);
        expect(outcome).toEqual({ fetched: 'refused', imported: 'refused' });
        // the load outcomes above are the channel that holds in every engine; the reports differ
        await sandbox.page.waitForTimeout(500); // violation events are queued as tasks, then cross the port
        const reported = (await sandbox.violations()).map(v => `${v.directive} ${v.blockedURI}`).sort();
        const expected: Record<string, string[]> = {
            // Chromium raises securitypolicyviolation in workers for both
            chromium: [`connect-src ${ATTACKER}/worker-fetch`, `script-src-elem ${ATTACKER}/worker-import.js`],
            // Firefox raises it for fetch, not for importScripts
            firefox: [`connect-src ${ATTACKER}/worker-fetch`],
            // WebKit raises none in workers: the load outcome is the only evidence there
            webkit: [],
        };
        expect(reported).toEqual(expected[browserName]);
    });
});


test.describe('5. strict mode', () => {
    test('view reports are labelled view, worker reports logic (per engine); forged frames on the logic port are logic and use up only the logic cap', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({ mode: 'strict' })).toBe('ready');
        // the worker's own refusals: Chromium raises both in the worker; Firefox raises the importScripts
        // refusal in the VIEW (research 15, P3); WebKit raises none in workers
        const outcome = await sandbox.inGuest(`
            const fetched = await fetch('${ATTACKER}/worker-fetch').then(() => 'reached', () => 'refused');
            let imported;
            try { importScripts('${ATTACKER}/worker-import.js'); imported = 'reached'; } catch (e) { imported = 'refused'; }
            return { fetched, imported };
        `);
        expect(outcome).toEqual({ fetched: 'refused', imported: 'refused' });
        await page.waitForTimeout(800);
        // then a flood of forged reports on the worker's own port, past the cap
        await sandbox.run(`const o = MessagePort.prototype.postMessage; MessagePort.prototype.postMessage = function (m, ...r) { MessagePort.prototype.postMessage = o; for (let i = 0; i < 150; i++) this.postMessage({ type: 'VIOLATION', directive: 'img-src', blockedURI: 'forged-' + i, source: 'view' }); return o.call(this, m, ...r); }; console.log('forged')`);
        await sandbox.waitForLog('forged');
        await page.waitForTimeout(500);
        // the view's own refusal still arrives, labelled view
        await sandbox.run(`sandboxView.render('<img src="${ATTACKER}/view.svg">')`);
        expect((await sandbox.waitForViolation('img-src', `${ATTACKER}/view.svg`)).source).toBe('view');

        const all = await sandbox.violations();
        const worker = all.filter(v => v.blockedURI.startsWith(`${ATTACKER}/worker`)).map(v => `${v.source} ${v.directive}`).sort();
        expect(worker).toEqual({
            chromium: ['logic connect-src', 'logic script-src-elem'],
            firefox: ['logic connect-src', 'view script-src-elem'],
            webkit: [],
        }[browserName]);
        // the logic port's cap: its real reports first, then forged ones up to 100, every one labelled logic
        // whatever the frame claimed
        const forged = all.filter(v => v.blockedURI.startsWith('forged-'));
        expect(all.filter(v => v.source === 'logic')).toHaveLength(100);
        expect(new Set(forged.map(v => v.source))).toEqual(new Set(['logic']));
    });
});
