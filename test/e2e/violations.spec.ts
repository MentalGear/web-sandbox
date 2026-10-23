import { test, expect } from './fixture';
import { GATE_SOURCE_FILE } from '@src/lib/violation';

/**
 * Backlog S5: CSP violations in the guest reach the host as a 'violation' event on the element.
 * Guarantees:
 *   1. a load the guest policy refuses is reported on the host, with a minimal validated detail; the event
 *      bubbles, and event.target names the sandbox;
 *   2. the listener is installed before any guest code runs: a violation raised while the guest markup is
 *      parsed is reported, and a guest listener registered later cannot keep ours from seeing one;
 *   3. a report is a guest claim, never a host fact: synthetic events are not forwarded, a frame forged on
 *      the port is validated and clamped, and the number of events per environment is capped;
 *   4. worker mode: the request gate reports the worker's refused fetch(), XMLHttpRequest and WebSocket on every
 *      engine; what the engine raises itself in the worker is forwarded too (per engine, below);
 *   5. strict mode (ADR-005, A6): the host labels each report by the port it arrived on, never by what the
 *      frame says. 'view' reports come from the view document, which runs no guest code, so they are the
 *      library's own and complete up to the cap, which is per port: a worker flooding its own (logic)
 *      port cannot use up the view's. 'logic' reports are the worker's: the request gate's, as in 4.
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

    test('guest code cannot reach the port (review B2), nor bend what the bootstrap reads: getters it puts on the event\'s prototype answer nothing, the reports are the browser\'s (review round 5, N-6)', async ({ sandbox }) => {
        expect(await sandbox.mount()).toBe('ready');
        // Guest code cannot take the port by patching MessagePort.prototype.postMessage to post VIOLATION frames of
        // its own (AR:B2): the bootstrap calls only primitives captured before guest code ran, so that yields nothing (asserted at length in channel-isolation.spec.ts). The bootstrap reads a violation event
        // through the platform's getters, captured before guest code ran (readEvent, R5:N-6), so getters
        // guest code puts on SecurityPolicyViolationEvent.prototype change nothing it reports. (The host validates and
        // clamps every report all the same: violation.ts.)
        await sandbox.run(`
            globalThis.__port = null;
            const original = MessagePort.prototype.postMessage;
            MessagePort.prototype.postMessage = function (...args) { globalThis.__port = this; return original.apply(this, args); };
            const forged = [
                { effectiveDirective: 'img-src; script-src *', blockedURI: 'x' },
                { effectiveDirective: 'connect-src', blockedURI: 'y'.repeat(10000), lineNumber: -4 },
                { effectiveDirective: 'connect-src', blockedURI: 'FORGED_DONE' },
            ];
            // which forgery an event gets follows from its real blockedURI (…/forge-<i>), read through the original getter
            const P = SecurityPolicyViolationEvent.prototype;
            const realBlocked = Object.getOwnPropertyDescriptor(P, 'blockedURI').get;
            for (const name of ['effectiveDirective', 'blockedURI', 'lineNumber']) {
                const d = Object.getOwnPropertyDescriptor(P, name);
                Object.defineProperty(P, name, { configurable: true, get() {
                    const f = forged[Number(realBlocked.call(this).slice(-1))];
                    return f && name in f ? f[name] : d.get.call(this);
                } });
            }
            for (let i = 0; i < 3; i++) new Image().src = '${ATTACKER}/forge-' + i;
            console.log('forging');
        `);
        await sandbox.waitForLog('forging');
        expect(await sandbox.inGuest('return globalThis.__port')).toBeNull();
        await sandbox.waitForViolation('img-src', `${ATTACKER}/forge-2`);
        await sandbox.page.waitForTimeout(300);
        const reported = await sandbox.violations();
        expect(reported.map(v => [v.directive, v.blockedURI])).toEqual([0, 1, 2].map(i => ['img-src', `${ATTACKER}/forge-${i}`]));
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

// A worker's fetch(), XMLHttpRequest and WebSocket refusals are reported by the library's request gate, on every engine,
// with one shape (in-sandbox-script.ts, S74). What the engine raises itself in a worker stays per engine (ADR-005, "Worker
// reports"; API.md, `violation`): WebKit raises no securitypolicyviolation event in a worker, and Firefox raises worker
// mode's importScripts() refusals in the frame that made the worker, which reports nothing.
test.describe('4. worker mode', () => {
    test('a refused fetch is reported by the request gate on every engine; importScripts() refusals are what the engine raises (Chromium only)', async ({ sandbox, browserName }) => {
        expect(await sandbox.mount({ mode: 'worker' })).toBe('ready');
        const outcome = await sandbox.inGuest(`
            const fetched = await fetch('${ATTACKER}/worker-fetch', { mode: 'no-cors' }).then(() => 'reached', () => 'refused');
            let imported;
            try { importScripts('${ATTACKER}/worker-import.js'); imported = 'reached'; } catch (e) { imported = 'refused'; }
            return { fetched, imported };
        `);
        expect(outcome).toEqual({ fetched: 'refused', imported: 'refused' });
        await sandbox.page.waitForTimeout(500); // violation events are queued as tasks, then cross the port
        const reported = (await sandbox.violations()).map(v => `${v.directive} ${v.blockedURI} ${v.sourceFile ?? ''}`.trim()).sort();
        const gate = `connect-src ${ATTACKER}/worker-fetch ${GATE_SOURCE_FILE}`;
        expect(reported.filter(line => line.startsWith('connect-src'))).toEqual([gate]);
        // importScripts() is the engine's: Chromium raises it in the worker, Firefox in the frame, WebKit nowhere
        expect(reported.filter(line => line.startsWith('script-src')).map(line => line.split(' ').slice(0, 2).join(' '))).toEqual(browserName === 'chromium' ? [`script-src-elem ${ATTACKER}/worker-import.js`] : []);
    });
});


test.describe('5. strict mode', () => {
    test('view reports are labelled view, the request gate\'s logic (the same on every engine); a flood on the logic port is logic and uses up only the logic cap', async ({ sandbox, page }) => {
        expect(await sandbox.mount({ mode: 'strict' })).toBe('ready');
        // the worker's own refusal, by the request gate; the strict worker has no importScripts
        const outcome = await sandbox.inGuest(`
            const fetched = await fetch('${ATTACKER}/worker-fetch').then(() => 'reached', () => 'refused');
            return { fetched, importScripts: typeof importScripts };
        `);
        expect(outcome).toEqual({ fetched: 'refused', importScripts: 'undefined' });
        await page.waitForTimeout(800);
        // then a flood of refusals in the worker, past the cap (guest code cannot post on the port itself, AR:B2: the
        // flood is the gate's reports of what it refused)
        await sandbox.run(`for (let i = 0; i < 150; i++) fetch('${ATTACKER}/flood-' + i).catch(() => {}); console.log('flooded')`);
        await sandbox.waitForLog('flooded');
        await page.waitForTimeout(800);
        // the view's own refusal still arrives, labelled view
        await sandbox.run(`sandboxView.render('<img src="${ATTACKER}/view.svg">')`);
        expect((await sandbox.waitForViolation('img-src', `${ATTACKER}/view.svg`)).source).toBe('view');

        const all = await sandbox.violations();
        const worker = all.filter(v => v.blockedURI.startsWith(`${ATTACKER}/worker`)).map(v => `${v.source} ${v.directive} ${v.sourceFile}`);
        expect(worker).toEqual([`logic connect-src ${GATE_SOURCE_FILE}`]);
        // the logic port's cap: its first report, then the flood up to 100, every one labelled logic; the view's
        // report above arrived after it, on its own count
        const flood = all.filter(v => v.blockedURI.startsWith(`${ATTACKER}/flood-`));
        expect(all.filter(v => v.source === 'logic')).toHaveLength(100);
        expect(new Set(flood.map(v => v.source))).toEqual(new Set(['logic']));
    });
});
