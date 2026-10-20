import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileStore } from '@src/lib/files';
import { createGuestWrites, GUEST_WRITES_PER_SECOND, GUEST_WRITE_BYTES_PER_SECOND } from '@src/lib/guest-writes';
import { createLogLimiter, LOG_EVENTS_PER_SECOND } from '@src/lib/sandbox-log';
import { AUTO_RESIZE_MAX_UPDATES_PER_SECOND, startAutoResize } from '@src/lib/auto-resize';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { parseOrigins } from '@src/lib/csp/origins';
import { cooperativePolicy, strictViewPolicy } from '@src/lib/csp/csp-generator';
import { deepMerge } from '@src/lib/utils';
import { prng } from './policy-helpers';

/**
 * Rate limits and config hardening (FR:W1 to FR:F6), host and library side: the guarantees
 * that only library logic decides. The browser halves are in test/e2e/inert-files-and-smil.spec.ts.
 */

async function mount(config?: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    if (config) el.setConfig(config);
    return el;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

// The largest total weight admitted in any half-open window [t, t + span) of the given (time, weight) list.
function busiestWindow(admitted: readonly [time: number, weight: number][], span = 1000): number {
    let best = 0;
    for (const [start] of admitted) {
        let sum = 0;
        for (const [time, weight] of admitted) if (time >= start && time < start + span) sum += weight;
        best = Math.max(best, sum);
    }
    return best;
}

describe('W2: every rate the library states per second holds in any one-second window', () => {
    it(`guest writes: at most ${GUEST_WRITES_PER_SECOND} requests in any 1000 ms span (a fixed window let 199 through around its boundary)`, () => {
        const store = new FileStore(() => {});
        let time = 0;
        const writes = createGuestWrites({ store, now: () => time });
        const admitted: [number, number][] = [];
        const attempt = (path: string) => {
            try {
                writes.handle({ change: 'write', path, entry: 'x' });
                admitted.push([time, 1]);
            } catch (e: any) {
                expect(e.code).toBe('FILES_BUSY');
            }
        };
        attempt('first.txt'); // t = 0 opens a fixed window
        time = 999;
        for (let i = 0; i < GUEST_WRITES_PER_SECOND; i++) attempt(`a/${i}.txt`);
        time = 1000;
        for (let i = 0; i < GUEST_WRITES_PER_SECOND; i++) attempt(`b/${i}.txt`);
        expect(busiestWindow(admitted)).toBeLessThanOrEqual(GUEST_WRITES_PER_SECOND);
    });

    it(`guest writes: at most ${GUEST_WRITE_BYTES_PER_SECOND} bytes in any 1000 ms span`, () => {
        const store = new FileStore(() => {});
        let time = 0;
        const writes = createGuestWrites({ store, now: () => time });
        const admitted: [number, number][] = [];
        const attempt = (size: number) => {
            try {
                writes.handle({ change: 'write', path: 'big.bin', entry: new Uint8Array(size) });
                admitted.push([time, size]);
            } catch (e: any) {
                expect(e.code).toBe('FILES_BUSY');
            }
        };
        attempt(1);
        time = 999;
        attempt(GUEST_WRITE_BYTES_PER_SECOND - 1);
        time = 1000;
        attempt(GUEST_WRITE_BYTES_PER_SECOND - 1); // a replacement: the quota allows it, only the rate can refuse it
        expect(busiestWindow(admitted)).toBeLessThanOrEqual(GUEST_WRITE_BYTES_PER_SECOND);
    });

    it('guest writes, property: random request times and sizes never exceed either rate in any 1000 ms span', { timeout: 30000 }, () => {
        for (let seed = 1; seed <= 20; seed++) {
            const random = prng(seed);
            const store = new FileStore(() => {});
            let time = 0;
            const writes = createGuestWrites({ store, now: () => time });
            const requests: [number, number][] = [];
            const bytes: [number, number][] = [];
            for (let i = 0; i < 600; i++) { // a few seconds of guest time each; sizes up to 400 KB, so the byte rate engages too
                time += Math.floor(random() * 40);
                const size = Math.floor(random() * 400000);
                try {
                    writes.handle({ change: 'write', path: `p${i % 10}.bin`, entry: new Uint8Array(size) });
                    requests.push([time, 1]);
                    bytes.push([time, size]);
                } catch (e: any) {
                    if (e.code !== 'FILES_BUSY') throw e;
                }
            }
            expect(requests.length, `seed ${seed}`).toBeGreaterThan(100); // the stream was admitted, not refused wholesale
            expect(busiestWindow(requests), `seed ${seed}`).toBeLessThanOrEqual(GUEST_WRITES_PER_SECOND);
            expect(busiestWindow(bytes), `seed ${seed}`).toBeLessThanOrEqual(GUEST_WRITE_BYTES_PER_SECOND);
        }
    });

    it(`guest log lines: at most ${LOG_EVENTS_PER_SECOND} in any 1000 ms span, also around a window boundary`, () => {
        let time = 0;
        const limiter = createLogLimiter(() => time);
        const admitted: [number, number][] = [];
        const offer = () => { if (limiter.admit()) admitted.push([time, 1]); };
        offer();
        time = 999;
        for (let i = 0; i < LOG_EVENTS_PER_SECOND; i++) offer();
        time = 1000;
        for (let i = 0; i < LOG_EVENTS_PER_SECOND; i++) offer();
        expect(busiestWindow(admitted)).toBeLessThanOrEqual(LOG_EVENTS_PER_SECOND);
        expect(admitted.length).toBe(LOG_EVENTS_PER_SECOND + 1); // positive control: the limit is reached, not undercut (the line at t = 0 left the window at t = 1000)
        time = 1999;
        expect(limiter.admit()).toBe(true); // the line at t = 999 has left the window
    });

    it(`auto-sizing (guarantee): at most ${AUTO_RESIZE_MAX_UPDATES_PER_SECOND} height writes in any 1000 ms span under a report flood`, () => {
        let time = 0;
        const frames: (() => void)[] = [];
        const timers: { at: number; run: () => void }[] = [];
        const applied: [number, number][] = [];
        const resizer = startAutoResize(() => applied.push([time, 1]), {
            now: () => time,
            requestFrame: (callback) => frames.push(callback),
            cancelFrame: () => {},
            setTimer: (run, ms) => { timers.push({ at: time + ms, run }); return 0 as any; },
            clearTimer: () => {},
        });
        for (let step = 0; step < 5000; step++) {
            time = step;
            resizer.report({ height: 100 + step }); // a new height every millisecond
            const due = timers.filter(t => t.at <= time);
            for (const timer of due) timers.splice(timers.indexOf(timer), 1);
            for (const timer of due) timer.run();
            if (step % 16 === 0) for (const frame of frames.splice(0)) frame(); // a frame every 16 ms
        }
        expect(applied.length).toBeGreaterThan(100);
        expect(busiestWindow(applied)).toBeLessThanOrEqual(AUTO_RESIZE_MAX_UPDATES_PER_SECOND);
    });
});

describe('W3: a removal mark never outlives the stored file it names', () => {
    it('the host unregistering the path after the mark: the mark is neither listed nor committed; a live mark is (positive control)', () => {
        const store = new FileStore(() => {});
        store.register({ 'a.txt': 'a', 'b.txt': 'b' });
        const writes = createGuestWrites({ store });
        expect(writes.handle({ change: 'remove', path: 'a.txt' })).toEqual({ path: 'a.txt', change: 'remove' });
        expect(writes.handle({ change: 'remove', path: 'b.txt' })).toEqual({ path: 'b.txt', change: 'remove' });
        store.unregister(['a.txt']);
        expect(writes.list()).toEqual([{ path: 'b.txt', change: 'remove' }]);
        expect(writes.commit(['a.txt', 'b.txt'], false)).toEqual(['b.txt']);
        expect(writes.list()).toEqual([]);
        expect(store.list()).toEqual([]);
    });

    it('on the element: listGuestWrites() after unregisterFiles() shows no mark for the path', async () => {
        const el = await mount({ guestWrites: true });
        el.registerFiles({ 'a.txt': 'a' });
        el.reset();
        el._guestWrites.handle({ change: 'remove', path: 'a.txt' });
        expect(el.listGuestWrites()).toEqual([{ path: 'a.txt', change: 'remove' }]);
        el.unregisterFiles(['a.txt']);
        expect(el.listGuestWrites()).toEqual([]);
    });
});

describe('W4: sandboxFiles.write() and remove() always return a promise', () => {
    it('an entry whose inspection throws (a revoked Proxy) rejects, never throws synchronously', async () => {
        const sent: unknown[] = [];
        const api = inSandboxFiles([], (request) => { sent.push(request); return Promise.resolve({}); });
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        let result: unknown;
        expect(() => { result = api.write('a.txt', proxy); }).not.toThrow();
        expect(result).toBeInstanceOf(Promise);
        await expect(result).rejects.toMatchObject({ name: 'TypeError' });
        // sandboxFiles tells content apart by brand checks (R2:C-1), which run no trap; reading the entry does
        const hostile = new Proxy({}, { get() { throw new Error('trap'); } });
        await expect(api.write('b.txt', hostile)).rejects.toThrow('trap');
        expect(sent).toEqual([]);
        // positive control: a plain entry is sent
        await api.write('c.txt', 'c');
        expect(sent).toHaveLength(1);
    });
});

describe('F3: a reason, event or host line never carries the text of a caught error, only a fixed text and the error\'s name', () => {
    const SECRET = 'S3CRET-in-the-error-text';
    const terminations = (el: any) => {
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        return reasons;
    };

    it('setConfig() with a value structured clone refuses (a function; Chromium quotes its source in the message) or a getter that throws', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        const reasons = terminations(el);
        // each build's 'terminated' comes in a task of its own (R1:R3-2), so each is awaited
        const settled = () => new Promise(resolve => setTimeout(resolve, 0));
        el.setConfig({ html: 'x', hook: function hook() { return SECRET; } });
        await settled();
        el.setConfig({ get mode() { throw new RangeError(SECRET); } });
        await settled();
        el.setConfig({ get mode() { throw { name: SECRET, message: SECRET }; } });
        await settled();
        el.setConfig({ get mode() { throw SECRET; } });
        await settled();
        expect(reasons).toEqual([
            'the configuration could not be used (DataCloneError)',
            'the configuration could not be used (RangeError)',
            'the configuration could not be used (Error)',
            'the configuration could not be used (string)',
        ]);
        for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(SECRET);
    });

    it('a build that throws ends with a fixed reason and the error name; a kind given a string is refused the same way', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        const reasons = terminations(el);
        const settled = () => new Promise(resolve => setTimeout(resolve, 0));
        el.setConfig({ origins: { images: `x; ${SECRET}` } });
        await settled();
        el._guestPolicy = () => { throw new Error(SECRET); };
        el.setConfig({});
        await settled();
        expect(reasons).toEqual(['the configuration could not be used (TypeError)', 'the environment could not be built (Error)']);
        for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(SECRET);
    });

    it("strict mode: the entry's own error text arrives as a guest line, never in the host line or the reason", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict' });
        const reasons = terminations(el);
        const lines: { source: string; args: readonly unknown[] }[] = [];
        el.addEventListener('sandbox-log', (e: CustomEvent) => lines.push({ source: e.detail.source, args: e.detail.args }));
        const { port1 } = new MessageChannel();
        el._viewPort = port1;
        el._onViewMessage(port1, { type: 'GUEST_ERROR', message: `SyntaxError: ${SECRET}` });
        expect(reasons).toEqual(['the guest entry failed to start']);
        expect(lines.filter(l => l.source === 'host').map(l => l.args)).toEqual([['[Sandbox] the guest entry failed to start']]);
        expect(lines.filter(l => l.source === 'guest').map(l => l.args)).toEqual([[`Uncaught SyntaxError: ${SECRET}`]]);
        port1.close();
    });

    it('source check: host.ts puts no error message into a reason or host line', () => {
        const source = readFileSync(join(__dirname, '../../src/host.ts'), 'utf8');
        expect(source).not.toMatch(/describeError/);
        expect(source).not.toMatch(/error\.message|\.message\}/);
    });
});

describe('F4: no config transform writes a config-derived key by assignment', () => {
    // An own "__proto__" key, as JSON.parse and structured clone produce it (AR:B8), at the top level.
    const injected = () => JSON.parse('{"__proto__": {"scripts": ["https://evil.example"], "images": ["https://evil.example"]}, "images": ["https://a.example"], "img-src": ["https://evil.example"]}');
    const steps: [string, (input: any) => unknown][] = [
        ['parseOrigins', (d) => parseOrigins(d, 'cooperative', () => {})],
        ['parseOrigins (strict)', (d) => parseOrigins(d, 'strict', () => {})],
        ['deepMerge', (d) => deepMerge({ images: [] } as any, d)],
    ];

    it.each(steps)('%s: the output has an ordinary prototype and no inherited kind', (_name, step) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const output = step(injected()) as Record<string, unknown>;
        expect(Object.getPrototypeOf(output) === Object.prototype || Object.getPrototypeOf(output) === null).toBe(true);
        for (const name of ['scripts', 'images']) {
            if (name in output) expect(Object.hasOwn(output, name), name).toBe(true);
            expect(JSON.stringify(output[name] ?? null)).not.toContain('evil.example');
        }
        expect(({} as any).scripts).toBeUndefined();
    });

    it('the policies made from them hold no inherited origin', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const mode of ['cooperative', 'strict']) {
            const origins = parseOrigins(injected(), mode, () => {});
            const input = { origins, fileKinds: new Set<never>(), scriptUnsafe: true };
            const policy = mode === 'strict' ? strictViewPolicy({ ...input, bootstrapHash: `'sha256-${'A'.repeat(43)}='` }) : cooperativePolicy(input);
            expect(policy, mode).not.toContain('evil.example');
            expect(policy, mode).toContain('img-src https://a.example;');
        }
    });

    it('property: any depth of "__proto__", "constructor" and "prototype" keys, never a prototype change or pollution', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const random = prng(7);
        const keys = ['__proto__', 'constructor', 'prototype', 'images', 'scripts', 'connect', 'img-src'];
        const value = (depth: number): unknown => (depth > 2 || random() < 0.5 ? ['https://evil.example'] : Object.fromEntries(Array.from({ length: 2 }, () => [keys[Math.floor(random() * keys.length)]!, value(depth + 1)])));
        for (let i = 0; i < 200; i++) {
            const text = JSON.stringify(Object.fromEntries(Array.from({ length: 3 }, () => [keys[Math.floor(random() * keys.length)]!, value(0)])));
            for (const [name, step] of steps) {
                let output: any;
                try {
                    output = step(JSON.parse(text));
                } catch {
                    continue; // a value a step refuses is not this test's concern
                }
                if (output && typeof output === 'object') expect([Object.prototype, null], `${name} ${text}`).toContain(Object.getPrototypeOf(output));
                expect(({} as any).images, name).toBeUndefined();
            }
        }
    });
});

describe("F5: 'unsafe-eval' is written in one place, the generator, and only with scriptUnsafe", () => {
    it('host.ts never spells the keyword in a write; csp-generator.ts holds it once', () => {
        const host = readFileSync(join(__dirname, '../../src/host.ts'), 'utf8');
        expect(host).not.toMatch(/push\(\s*"'unsafe-eval'"\s*\)|\[[^\]]*"'unsafe-eval'"[^\]]*\]/);
        const generator = readFileSync(join(__dirname, '../../src/lib/csp/csp-generator.ts'), 'utf8');
        expect(generator.match(/= "'unsafe-eval'"/g)).toHaveLength(1);
    });
});

describe('F6: a refused config is never stored', () => {
    it("strict mode with origins: null is refused before anything is stored: the previous config stays", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        // (worker mode ignores html, which the schema stores as its default there: watchdogTimeout marks the previous config)
        const el = await mount({ mode: 'worker', watchdogTimeout: 9, workerExecutionTimeout: 7, origins: { images: ['https://kept.example'] } });
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        el.setConfig({ mode: 'strict', origins: null });
        await new Promise(resolve => setTimeout(resolve, 0)); // a build's 'terminated' comes in a task (R1:R3-2)
        expect(reasons).toEqual(['the configuration could not be used (TypeError)']);
        expect([el._config.mode, el._config.watchdogTimeout, el._config.workerExecutionTimeout, el._origins.images]).toEqual(['worker', 9, 7, ['https://kept.example']]);
    });

    it('origins that is not an object, or a kind that is not a list, is refused in every mode, before a build', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        for (const mode of ['cooperative', 'worker', 'strict']) {
            for (const value of [null, 'https://a.example', ['x'], 5, { images: 'https://a.example' }, { connect: null }]) {
                el.setConfig({ mode, origins: value });
                await new Promise(resolve => setTimeout(resolve, 0)); // each build's 'terminated' in a task (R1:R3-2)
            }
        }
        expect(reasons).toEqual(new Array(18).fill('the configuration could not be used (TypeError)'));
        el.setConfig({ origins: { images: ['https://a.example'] } });
        expect(el.state).toBe('loading'); // positive control
    });
});

describe('Hardening: sandbox:fetch is bound to the build it belongs to, like sandbox:write', () => {
    it("a request that arrived in environment N but runs after a rebuild is refused by N's closed bridge, never served by N+1's", async () => {
        const el = await mount({ fetchBridge: { allow: ['https://api.example'] } });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'));
        const { port1 } = new MessageChannel();
        el._port = port1;
        const answers: any[] = [];
        const request = { url: 'https://api.example/data', method: 'GET', headers: [] };
        el._onGuestMessage(port1, (frame: unknown) => answers.push(frame), { type: 'RPC_REQ', id: 1, method: 'sandbox:fetch', args: [request] }, null);
        el.reset(); // synchronously, before the broker's microtask runs the method
        await settle();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(answers).toMatchObject([{ ok: false, code: 'FETCH_FAILED' }]);

        // positive control: the same request in the current environment is served
        const { port1: next } = new MessageChannel();
        el._port = next;
        const served: any[] = [];
        el._onGuestMessage(next, (frame: unknown) => served.push(frame), { type: 'RPC_REQ', id: 2, method: 'sandbox:fetch', args: [request] }, null);
        await vi.waitFor(() => expect(served).toHaveLength(1));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(served[0]).toMatchObject({ ok: true });
        port1.close();
        next.close();
    });
});

describe('W1: a reference names a file only for the kind of load its type is for (one table: load-kinds.ts)', () => {
    const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
    const guestDocumentOf = (el: HTMLElement) => parse(el.shadowRoot!.querySelector('iframe')!.srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!;
    const bootstrapOf = (el: HTMLElement) => parse(guestDocumentOf(el)).querySelector('script')!.textContent!;
    // the markup parts the bootstrap writes: [markup, slot, markup, ...]; a slot is its own JSON string element
    const slotsOf = (el: HTMLElement) => {
        const text = bootstrapOf(el);
        return ['app.js', 'ok.js', 'host.js', 'style.txt', 'pic.css', 'pic.png'].filter(path => text.includes(`,${JSON.stringify(path)},`));
    };

    it('a guest-written app.js committed as text/plain (no { code: true } needed) gets no script slot in the next build; JavaScript committed with { code: true } does (positive control)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], guestWrites: true, html: '<script src="app.js"></script><script src="ok.js"></script>' });
        el._guestWrites.handle({ change: 'write', path: 'app.js', entry: { content: new TextEncoder().encode('globalThis.ran = 1'), type: 'text/plain' } });
        el._guestWrites.handle({ change: 'write', path: 'ok.js', entry: { content: new TextEncoder().encode('globalThis.ok = 1'), type: 'text/javascript' } });
        el.commitGuestWrites(['app.js']);
        el.commitGuestWrites(['ok.js'], { code: true });
        el.reset();
        expect(el.listFiles().map((f: any) => [f.path, f.type])).toEqual([['app.js', 'text/plain'], ['ok.js', 'text/javascript']]);
        expect(slotsOf(el)).toEqual(['ok.js']);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('"app.js"') && m.includes('text/plain'))).toHaveLength(1);
    });

    it('the same for host-registered files: x.js registered as text/plain is not a script; a stylesheet link never names a text file, an image never a stylesheet; an image does (positive control)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], html: '<script src="host.js"></script><link rel="stylesheet" href="style.txt"><img src="pic.css"><img src="pic.png">' });
        el.registerFiles({ 'host.js': { content: 'globalThis.ran = 1', type: 'text/plain' }, 'style.txt': 'a {}', 'pic.css': 'a {}', 'pic.png': new Uint8Array([137, 80]) });
        el.reset();
        expect(slotsOf(el)).toEqual(['pic.png']);
    });
});
