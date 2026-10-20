import type { Page } from '@playwright/test';
import { test, expect, type SandboxDriver } from './fixture';
import { useRecorder } from './recorder';

/**
 * Channels and lifecycle (AR:B1 to AR:B8), in the browser:
 *   B1  another frame on the host page that announces a port to the host window (SANDBOX_PORT, with or without a
 *       port of its own), racing the guest's own announcement, neither captures the bridge nor leaves it dead: the
 *       host hears only the guest frame's window. (The guest takes no port from any message, BR:CB1, so the race is
 *       at the host's listener.);
 *   B2  the port never reaches guest code, whatever prototypes it patches, so the watchdog cannot be answered
 *       by a delegate while the guest loops;
 *   B4  frames already on their way from an environment that a listener reset are not dispatched;
 *   B7  inbound calls in flight are capped per environment, beyond that refused at once with BUSY;
 *   B8  structured clone keeps an own "__proto__" key: what arrives from the guest is data to read, not to merge.
 * Evidence (T5): what the host dispatches and how calls settle, read on the host page; the guest's own view
 * through execute(); a positive control for each mechanism the guarantee depends on.
 */

const recorder = useRecorder();

const BUDGET = 1000;
const DEADLINE = BUDGET * 1.25 + 1000;

// ---- B1 ------------------------------------------------------------------------------------------------

/**
 * Starts "another frame on the host page": a same-origin iframe whose own script announces itself to the host window
 * every 5 ms the way the guest's bootstrap does (SANDBOX_PORT), alternately without a port and with one it listens on.
 * Posted from its own realm, so the host sees it as the message source. window.strangerHeard collects what its ports
 * received; window.strangerDelivered counts its announcements that reached the host window (a listener the page adds
 * before the element's own, so it sees every one: the positive control that they arrive while the host listens).
 */
async function startStranger(page: Page) {
    await page.evaluate(() => {
        const frame = document.createElement('iframe');
        frame.id = 'stranger';
        document.body.append(frame);
        (window as any).strangerHeard = [];
        (window as any).strangerDelivered = 0;
        window.addEventListener('message', (e) => { if (e.source === frame.contentWindow && e.data?.type === 'SANDBOX_PORT') (window as any).strangerDelivered++; }, true);
        const run = (frame.contentWindow as any).Function('heard', `
            let n = 0;
            return setInterval(() => {
                n++;
                if (n % 2) { parent.postMessage({ type: 'SANDBOX_PORT' }, '*'); return; }
                const channel = new MessageChannel();
                channel.port1.onmessage = (e) => heard.push(JSON.stringify(e.data));
                parent.postMessage({ type: 'SANDBOX_PORT' }, '*', [channel.port2]);
            }, 5);
        `);
        (window as any).strangerTimer = run((window as any).strangerHeard);
    });
}

async function stopStranger(page: Page) {
    await page.evaluate(() => {
        const frame = document.getElementById('stranger') as HTMLIFrameElement;
        (frame.contentWindow as any).clearInterval((window as any).strangerTimer);
    });
}

test('B1: another frame on the host page announcing ports to the host window, racing the guest\'s own announcement, neither captures the bridge nor leaves it dead; the guest\'s announcement is the one heard', async ({ sandbox, page }) => {
    // The guest's image holds its load open for 1.5 s, so the stranger's announcements arrive before, around and after
    // the guest's own, which the host takes from its first statement on.
    const html = `<p>guest</p><img src="${recorder.allowed}/delay?ms=1500">`;
    await page.evaluate(() => {
        (window as any).terminations = [];
        document.querySelector('web-sandbox')!.addEventListener('terminated', (e) => (window as any).terminations.push((e as CustomEvent).detail.reason));
    });
    await startStranger(page);
    expect(await sandbox.mount({ html, watchdogTimeout: 2000, origins: { images: [recorder.allowed] } })).toBe('ready');
    await page.waitForTimeout(300); // more announcements after ready, with the watchdog pinging the real port
    await stopStranger(page);

    expect(await page.evaluate(() => (window as any).strangerDelivered)).toBeGreaterThan(20); // positive control
    // the host's port is the bridge's: the bootstrap announced itself on it, and calls work both ways
    await sandbox.waitForLog('cooperative Ready', 5000);
    await sandbox.exposeGuest('twice', '(x) => x * 2');
    expect(await sandbox.call('twice', 21)).toBe(42);
    // no announcement of the stranger's ended the environment, and its ports never heard a thing (not a PING, not a call)
    expect(await page.evaluate(() => (window as any).terminations)).toEqual([]);
    expect(await sandbox.state()).toBe('ready');
    expect(await page.evaluate(() => (window as any).strangerHeard)).toEqual([]);
});

// ---- B2 ------------------------------------------------------------------------------------------------

/**
 * Guest code that patches every primitive through which a port could be seen — MessagePort.prototype
 * (postMessage, onmessage, addEventListener), MessageEvent.prototype (data, ports, source), Event.prototype
 * (target, currentTarget, stopImmediatePropagation), Function.prototype.call/apply and Reflect.apply — keeps
 * every MessagePort it sees, then makes the bootstrap post (a log line) and answer.
 */
const PATCH_EVERYTHING = `
    globalThis.__ports = [];
    const keep = (p) => { if (p instanceof MessagePort && !__ports.includes(p)) __ports.push(p); };
    const reflectApply = Reflect.apply;
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...a) { keep(this); return reflectApply(post, this, a); };
    const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
    Object.defineProperty(MessagePort.prototype, 'onmessage', { configurable: true, get() { keep(this); return reflectApply(onmessage.get, this, []); }, set(v) { keep(this); reflectApply(onmessage.set, this, [v]); } });
    const targetOf = Object.getOwnPropertyDescriptor(Event.prototype, 'target').get;
    for (const [proto, name] of [[MessageEvent.prototype, 'data'], [MessageEvent.prototype, 'ports'], [MessageEvent.prototype, 'source'], [Event.prototype, 'target'], [Event.prototype, 'currentTarget']]) {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        Object.defineProperty(proto, name, { configurable: true, get() { const v = reflectApply(d.get, this, []); keep(v); if (Array.isArray(v)) v.forEach(keep); keep(reflectApply(targetOf, this, [])); return v; } });
    }
    const stop = Event.prototype.stopImmediatePropagation;
    Event.prototype.stopImmediatePropagation = function () { keep(reflectApply(targetOf, this, [])); return reflectApply(stop, this, []); };
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (...a) { keep(this); return reflectApply(add, this, a); };
    Function.prototype.call = function (self, ...a) { keep(self); a.forEach(keep); return reflectApply(this, self, a); };
    Function.prototype.apply = function (self, a) { keep(self); if (a) Array.prototype.forEach.call(a, keep); return reflectApply(this, self, a || []); };
    Reflect.apply = function (f, self, a) { keep(self); if (a) Array.prototype.forEach.call(a, keep); return reflectApply(f, self, a); };
    console.log('after the patches');
`;

/** A nested worker that answers the host's PINGs on whatever port it is handed: the delegate a captured port would get. */
const DELEGATE = `new Worker(URL.createObjectURL(new Blob([\`onmessage = (e) => { const port = e.ports[0]; port.onmessage = (m) => { if (m.data && m.data.type === 'PING') port.postMessage({ type: 'PONG', n: m.data.n }); }; port.postMessage({ type: 'DELEGATE_UP' }); };\`], { type: 'text/javascript' })))`;

test.describe('B2: the port never reaches guest code', () => {
    for (const mode of ['cooperative', 'worker'] as const) {
        test(`${mode} mode: patching every port, event and call primitive yields no port; a delegate worker answers pings on a port it is handed (positive control)`, async ({ sandbox }) => {
            expect(await sandbox.mount({ mode, watchdogTimeout: BUDGET })).toBe('ready');
            await sandbox.run(PATCH_EVERYTHING);
            await sandbox.waitForLog('after the patches');
            await sandbox.exposeGuest('echo', '(x) => x');
            expect(await sandbox.call('echo', 'still works')).toBe('still works');
            await sandbox.page.waitForTimeout(BUDGET); // a few watchdog PINGs answered meanwhile
            expect(await sandbox.inGuest('return __ports.length')).toBe(0);

            // positive control: a port the guest does hold (its own channel) is answered by the delegate. Worker mode has
            // no nested Worker since the independent verification (V1, worker-globals.ts), so there the delegate is a
            // listener of the guest's own on the other end: what a captured port would let it do in the worker itself.
            const answered = await sandbox.inGuest(`
                const channel = new MessageChannel();
                const delegate = typeof Worker === 'function' ? ${DELEGATE} : { postMessage: (_, [port]) => { port.onmessage = (m) => { if (m.data && m.data.type === 'PING') port.postMessage({ type: 'PONG', n: m.data.n }); }; port.postMessage({ type: 'DELEGATE_UP' }); } };
                ${mode === 'worker' ? "if (typeof Worker !== 'undefined') return 'worker mode has a Worker';" : ''}
                delegate.postMessage(null, [channel.port2]);
                return await new Promise((resolve) => {
                    channel.port1.onmessage = (e) => { if (e.data.type === 'PONG') resolve(e.data.n); else channel.port1.postMessage({ type: 'PING', n: 7 }); };
                    setTimeout(() => resolve('no answer'), 4000);
                });
            `);
            expect(answered).toBe(7);
        });
    }

    test('worker mode: a guest that hands any port it captured to a delegate and then loops is still terminated by the watchdog within the budget', async ({ sandbox, page }) => {
        expect(await sandbox.mount({ mode: 'worker', watchdogTimeout: BUDGET })).toBe('ready');
        await sandbox.run(PATCH_EVERYTHING);
        await sandbox.waitForLog('after the patches');
        await page.evaluate(() => {
            const s = document.querySelector('web-sandbox') as any;
            (window as any).termination = null;
            const started = performance.now();
            s.addEventListener('terminated', (e: CustomEvent) => { (window as any).termination = { reason: e.detail.reason, elapsed: performance.now() - started }; }, { once: true });
        });
        // hand over whatever was captured, give the delegate time to start, then loop forever
        await sandbox.run(`
            for (const port of __ports) { const d = ${DELEGATE}; d.postMessage(null, [port]); }
            const until = Date.now() + 300; while (Date.now() < until) {}
            setTimeout(() => { while (true) {} }, 300);
        `);
        await page.waitForFunction(() => (window as any).termination !== null, null, { timeout: DEADLINE + 3000 });
        const termination = await page.evaluate(() => (window as any).termination);
        expect(termination.reason).toBe('the guest stopped responding (watchdog)');
        expect(termination.elapsed).toBeLessThan(DEADLINE + 600);
    });
});

// ---- B4 ------------------------------------------------------------------------------------------------

test.describe('B4: a listener that resets the sandbox mid-flood hears nothing more from the old environment', () => {
    for (const mode of ['cooperative', 'worker'] as const) {
        test(`${mode} mode: 500 log lines and 100 violation reports already on their way; reset() from the first line's listener; none of the rest is dispatched`, async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            await page.evaluate(() => {
                const s = document.querySelector('web-sandbox') as any;
                (window as any).afterReset = [];
                let resetDone = false;
                const record = (e: CustomEvent) => {
                    const text = e.type === 'violation' ? e.detail.blockedURI : String(e.detail.args[0]);
                    if (!text.includes('OLD-')) return;
                    if (resetDone) { (window as any).afterReset.push(text); return; }
                    resetDone = true;
                    s.reset();
                };
                s.addEventListener('sandbox-log', record);
                s.addEventListener('violation', record);
            });
            await sandbox.run(`
                for (let i = 0; i < 100; i++) fetch('https://attacker.test/OLD-' + i).catch(() => {});
                for (let i = 0; i < 500; i++) console.log('OLD-' + i);
            `);
            await page.waitForFunction(() => (document.querySelector('web-sandbox') as any).state === 'ready', null, { timeout: 10000 });
            await page.waitForTimeout(800);
            expect(await page.evaluate(() => (window as any).afterReset)).toEqual([]);
            // positive control: the new environment is heard
            await sandbox.run(`console.log('NEW-line')`);
            await sandbox.waitForLog('NEW-line');
        });
    }
});

// ---- B7 ------------------------------------------------------------------------------------------------

async function busyCount(sandbox: SandboxDriver, calls: number): Promise<{ busy: number; elapsed: number }> {
    return sandbox.inGuest(`
        const started = Date.now();
        const outcomes = [];
        for (let i = 0; i < ${calls}; i++) bridge.callWithTimeout(0, 'never').then(() => {}, (e) => outcomes.push(e.code));
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return { busy: outcomes.filter((c) => c === 'BUSY').length, elapsed: Date.now() - started, other: outcomes.filter((c) => c !== 'BUSY') };
    `);
}

test('B7: 300 calls to a host method that never settles: 256 run, 44 are refused at once with BUSY; the next environment has its own count', async ({ sandbox }) => {
    expect(await sandbox.mount()).toBe('ready');
    await sandbox.exposeHost('never', '() => new Promise(() => {})');
    expect(await busyCount(sandbox, 300)).toMatchObject({ busy: 44, other: [] });
    expect(await sandbox.reset()).toBe('ready');
    expect(await busyCount(sandbox, 256)).toMatchObject({ busy: 0, other: [] });
});

// ---- B8 ------------------------------------------------------------------------------------------------

test('B8 (documented): an own "__proto__" key survives structured clone into host code; reading it is safe, merging it with Object.assign sets a prototype', async ({ sandbox, page }) => {
    expect(await sandbox.mount()).toBe('ready');
    await sandbox.exposeHost('take', `(arg) => {
        const assigned = Object.assign({}, arg);
        const spread = { ...arg };
        window.b8 = {
            own: Object.hasOwn(arg, '__proto__'),
            argPrototypeIsObject: Object.getPrototypeOf(arg) === Object.prototype,
            assignedChangedPrototype: Object.getPrototypeOf(assigned) !== Object.prototype,
            spreadKeepsOwnKey: Object.hasOwn(spread, '__proto__') && Object.getPrototypeOf(spread) === Object.prototype,
            polluted: ({}).polluted !== undefined,
        };
        return true;
    }`);
    await sandbox.inGuest(`return bridge.call('take', JSON.parse('{"__proto__": {"polluted": 1}, "a": 1}'))`);
    expect(await page.evaluate(() => (window as any).b8)).toEqual({ own: true, argPrototypeIsObject: true, assignedChangedPrototype: true, spreadKeepsOwnKey: true, polluted: false });
});
