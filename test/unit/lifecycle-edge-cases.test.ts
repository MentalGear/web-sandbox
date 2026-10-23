import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineWebSandbox } from '@src/host';
import { createBroker } from '@src/lib/rpc';
import { startWatchdog } from '@src/lib/watchdog';
import { SyntaxKind, tokenize } from '../../scripts/js-tokens';
import { checkIn } from './check-in';

/**
 * Findings of R2 from model-based lifecycle testing: each reproduced here first, against the element
 * in jsdom. The engine-specific ones (R2:L-1 and R2:L-5 in a real iframe's document) are in test/e2e/foreign-document-and-view-time.spec.ts.
 */

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const task = () => new Promise(resolve => setTimeout(resolve, 0));

function element(config?: Record<string, unknown>) {
    defineWebSandbox();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    if (config) el.setConfig(config);
    const events: string[] = [];
    el.addEventListener('ready', () => events.push('ready'));
    el.addEventListener('terminated', (event: CustomEvent) => events.push(`terminated: ${event.detail.reason}`));
    return { el, events };
}

describe("L-1: in another window's document nothing builds, whatever starts the build", () => {
    it('reset(), load() and setConfig() there leave the element idle: no frame, no event, calls refused at once', async () => {
        const { el, events } = element({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        const other = document.implementation.createHTMLDocument('another window');
        other.body.appendChild(el);
        expect([el.isConnected, el.ownerDocument === other, el.state]).toEqual([true, true, 'idle']);
        el.reset();
        expect(el.state).toBe('idle');
        el.load('<p>x</p>');
        expect(el.state).toBe('idle');
        el.setConfig({ mode: 'cooperative', origins: 5 }); // refused: still nothing, not even a termination
        expect(el.state).toBe('idle');
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        expect(el.state).toBe('idle');
        expect(el.shadowRoot.querySelector('iframe')).toBeNull();
        await task();
        expect(events).toEqual([]);
        await expect(el.call('anything')).rejects.toMatchObject({ code: 'TERMINATED' });
        // positive control: back in its own document, it builds
        document.body.appendChild(el);
        expect(el.state).toBe('loading');
    });
});

describe('L-2: a delay of 2^31 ms or more waits; Infinity is off', () => {
    it("callWithTimeout(2 ** 31) times out after 2^31 ms, not at once; callWithTimeout(Infinity) never", async () => {
        vi.useFakeTimers();
        const broker = createBroker(() => {});
        const outcomes: string[] = [];
        broker.callWithTimeout(2 ** 31, 'long').catch((error: any) => outcomes.push(`long ${error.code}`));
        broker.callWithTimeout(Infinity, 'never').catch((error: any) => outcomes.push(`never ${error.code}`));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(outcomes).toEqual([]);
        await vi.advanceTimersByTimeAsync(2 ** 31);
        expect(outcomes).toEqual(['long TIMEOUT']);
        await vi.advanceTimersByTimeAsync(2 ** 33);
        expect(outcomes).toEqual(['long TIMEOUT']);
    });

    it('a watchdog of 2^33 ms does not expire within seconds', async () => {
        vi.useFakeTimers();
        const onExpire = vi.fn();
        const watchdog = startWatchdog({ timeoutMs: 2 ** 33, ping: () => {}, onExpire });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onExpire).not.toHaveBeenCalled();
        watchdog.stop();
    });

    it('workerExecutionTimeout of 2^33 ms does not end a sandbox whose code runs for seconds', async () => {
        const { el, events } = element({ mode: 'worker', scriptUnsafe: true, workerExecutionTimeout: 2 ** 33 });
        const { port1 } = new MessageChannel();
        el._port = port1;
        vi.useFakeTimers();
        el.execute('for (;;) {}'); // nothing answers the port: a busy loop, as far as the host can tell
        await vi.advanceTimersByTimeAsync(60_000);
        expect(el.state).not.toBe('terminated');
        expect(events.filter(event => event.startsWith('terminated'))).toEqual([]);
        port1.close();
    });

    // Every setTimeout in the library takes a delay of the library's own choosing; a delay a config or a caller chooses
    // goes through setLongTimeout (src/lib/long-timer.ts), which rpc.ts mirrors inside createBroker.
    it('no other setTimeout in the library takes a delay a config or a caller chose', () => {
        const ALLOWED: Record<string, string> = {
            'src/lib/long-timer.ts': 'the helper itself',
            'src/lib/auto-resize.ts': 'at most AUTO_RESIZE_MIN_INTERVAL_MS, a constant',
            'src/lib/in-sandbox-view.ts': "the view's own rate arithmetic: at most the time its budget takes to cover one flush",
            'src/lib/host-csp.ts': 'READ_TIMEOUT_MS and SETTLE_MS, constants of the read of the host page\'s policy',
        };
        const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return files(path);
            return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
        });
        const found: string[] = [];
        for (const path of files('src')) {
            const tokens = tokenize(readFileSync(path, 'utf8'));
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i]!.text !== 'setTimeout' || tokens[i - 1]?.kind === SyntaxKind.DotToken) continue;
                if (tokens[i + 1]?.kind !== SyntaxKind.OpenParenToken) {
                    if (path !== 'src/lib/rpc.ts' && tokens[i - 1]?.kind !== SyntaxKind.TypeOfKeyword) found.push(`${path}: setTimeout passed on`);
                    continue;
                }
                // the delay: the call's last argument, a numeric literal unless the file is allowed
                let depth = 0;
                let j = i + 1;
                for (; j < tokens.length; j++) {
                    if (tokens[j]!.kind === SyntaxKind.OpenParenToken) depth++;
                    if (tokens[j]!.kind === SyntaxKind.CloseParenToken && --depth === 0) break;
                }
                const literal = tokens[j - 1]!.kind === SyntaxKind.NumericLiteral && tokens[j - 2]!.kind === SyntaxKind.CommaToken;
                if (!literal && !ALLOWED[path]) found.push(`${path}: setTimeout(…, ${tokens[j - 1]!.text})`);
            }
        }
        expect(found).toEqual([]);
        // rpc.ts, stringified into the guest, chains its own timer the same way
        const rpc = readFileSync('src/lib/rpc.ts', 'utf8');
        expect(rpc).toMatch(/\bMAX_TIMER_DELAY(?:: [^=]+)? = 2147483647\b/);
        expect([...rpc.matchAll(/\bsetTimer\(/g)]).toHaveLength(1);
        expect(rpc).toMatch(/setTimer\(\(\) => \{[^]*?\}, step\)/);
    });
});

describe('L-3: work queued while loading is sent in the order it was issued', () => {
    it("call('get'), then execute('v = 1'): the call goes first", () => {
        const { el } = element({ mode: 'cooperative', capabilities: ['allow-scripts'], scriptUnsafe: true });
        expect(el.state).toBe('loading');
        void el.call('get').catch(() => {});
        el.execute('v = 1');
        void el.call('after').catch(() => {});
        const { port1 } = new MessageChannel();
        const posted: any[] = [];
        port1.postMessage = (frame: unknown) => { posted.push(frame); };
        checkIn(el, port1); // the build becomes ready: what waited is posted then (R5:L-1)
        expect(posted.map(frame => (frame.type === 'RPC_REQ' ? `call ${frame.method}` : `execute ${frame.code}`))).toEqual(['call get', 'execute v = 1', 'call after']);
        port1.close();
    });
});

describe("L-4: a 'terminated' listener that builds again to the same answer hears it once", () => {
    it('a build that throws (here the frame itself): a listener whose load() fails the same way dispatches nothing more', async () => {
        const { el, events } = element({ mode: 'cooperative' });
        await task();
        events.length = 0;
        // the build's own failure, whatever its cause (the executor applies the build through the class's prototype, CB7)
        const build = vi.spyOn(Object.getPrototypeOf(el), '_prepareBuild').mockImplementation(() => { throw new TypeError('no frame'); });
        let builds = 0;
        el.addEventListener('terminated', () => {
            if (++builds <= 50) el.load(`<p>${builds}</p>`);
        });
        el.load('<p>0</p>');
        for (let i = 0; i < 20; i++) await task();
        expect(events).toEqual(['terminated: the environment could not be built (TypeError)']);
        expect(el.state).toBe('terminated');
        build.mockRestore();
        el.load('<p>again</p>'); // positive control: a build that works builds
        expect(el.state).toBe('loading');
    });

    for (const again of ['setConfig(same)', 'load()'] as const) {
        it(`strict mode, an entry that is not registered: the listener's ${again} is the same answer, not dispatched again`, async () => {
            const config = { mode: 'strict', entry: 'missing.js' };
            const { el, events } = element();
            let builds = 0;
            el.addEventListener('terminated', () => {
                if (++builds > 50) return;
                if (again === 'load()') el.load(`<p>${builds}</p>`);
                else el.setConfig(config);
            });
            el.setConfig(config);
            for (let i = 0; i < 20; i++) await task();
            expect(events).toEqual(['terminated: the guest entry "missing.js" is not a registered JavaScript file']);
            expect(el.state).toBe('terminated');
        });
    }
});

describe('L-6: a load of a frame that is no longer in the document completes nothing', () => {
    it("the wrapper's load while the element is being removed (before disconnectedCallback) dispatches no 'ready'", () => {
        const { el, events } = element({ mode: 'cooperative' }); // no allow-scripts: the build completes on the frame's load
        const iframe = el.shadowRoot.querySelector('iframe');
        expect(el.state).toBe('loading');
        // Chromium and WebKit fire the frame's load on detach, inside remove(), before the element's disconnectedCallback
        Object.defineProperty(el, 'isConnected', { configurable: true, get: () => false });
        iframe.onload(new Event('load'));
        expect(events).toEqual([]);
        expect(el.state).toBe('loading');
        delete el.isConnected;
        // and a load of a frame that is not the element's current one
        iframe.remove();
        iframe.onload?.(new Event('load'));
        expect(events).toEqual([]);
    });
});

describe('L-7: terminate() with an empty or blank reason gives the default reason', () => {
    it("terminate('') and terminate('   ') say 'terminated by the host'", async () => {
        for (const reason of ['', '   ']) {
            const { el, events } = element({ mode: 'cooperative' });
            el.terminate(reason);
            expect(events).toEqual(['terminated: terminated by the host']);
            el.remove();
        }
    });
});
