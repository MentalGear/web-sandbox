import { describe, it, expect, afterEach } from 'vitest';
import { inStrictWorker, RENDER_RULES, sanitizeRender, VIEW_APPLY_MS_PER_SECOND, VIEW_MAX_OPERATION_MS, VIEW_OPTIONS, VIEW_RENDER_CHARACTERS_PER_SECOND, VIEW_URLS_PER_SECOND, viewBootstrapSource, viewBudget, type ViewOptions } from '@src/lib/in-sandbox-view';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

/**
 * Review round 5, the strict view's findings (unit): the library's own logic where no browser decides. Each test failed
 * at 60814b5. The engines' side is in test/e2e/view-round-5.spec.ts.
 */

// jsdom makes no trusted event of its own (dispatchEvent() makes every event untrusted), so the listener is called
// directly, with an event whose implementation holds the flag the browser sets.
function trusted<T extends Event>(event: T): T {
    const impl = Object.getOwnPropertySymbols(event).find(symbol => symbol.description === 'impl')!;
    (event as any)[impl].isTrusted = true;
    return event;
}

describe("N-2 (class G): the strict prelude's error listener reads the event only through getters it captured", () => {
    // The prelude, run as stringified with globalThis bound to a stand-in global; its listeners are recorded.
    const start = () => {
        const w = new EventTarget() as any;
        Object.assign(w, { URL: {} });
        const lines: unknown[][] = [];
        const listeners: Record<string, (event: Event) => void> = {};
        const add = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: any, options?: any) {
            if (this === w) listeners[type] = listener;
            return add.call(this, type, listener, options);
        };
        const run = new Function('globalThis', `return (${inStrictWorker.toString()})`)(w);
        try {
            run({ attach: () => {}, log: (_level: string, args: unknown[]) => lines.push(args) }, { scriptUnsafe: false, maxRender: 100, maxTarget: 5, maxElements: 100, maxDepth: 10, maxCharacters: 100, maxUrls: 10, entryDoneName: '__testEntryDone', eventTypes: ['click'] });
        } finally {
            EventTarget.prototype.addEventListener = add;
        }
        w.__testEntryDone(); // the entry ran: every later error is the prelude's to cancel and log
        return { onError: listeners['error']!, lines };
    };
    const raise = (onError: (event: Event) => void, message: string) => {
        const event = trusted(new ErrorEvent('error', { message, error: new Error(message), cancelable: true }));
        onError(event);
        return event.defaultPrevented;
    };
    const descriptors = () => ['error', 'message'].map(name => [name, Object.getOwnPropertyDescriptor(ErrorEvent.prototype, name)!] as const);

    it('getters the guest replaced to make an error look muted: the error is still cancelled, and logged with its own text', () => {
        const { onError, lines } = start();
        const saved = descriptors();
        Object.defineProperty(ErrorEvent.prototype, 'error', { configurable: true, get: () => null });
        Object.defineProperty(ErrorEvent.prototype, 'message', { configurable: true, get: () => 'Script error.' });
        let cancelled: boolean;
        try {
            cancelled = raise(onError, 'Error: spoofed');
        } finally {
            for (const [name, descriptor] of saved) Object.defineProperty(ErrorEvent.prototype, name, descriptor);
        }
        expect(cancelled).toBe(true);
        expect(lines).toEqual([['Uncaught Error: spoofed']]);
    });

    it('getters the guest replaced to throw: the listener neither throws nor lets the error past', () => {
        const { onError, lines } = start();
        const saved = descriptors();
        const thrower = { configurable: true, get: () => { throw new Error('guest getter'); } };
        Object.defineProperty(ErrorEvent.prototype, 'error', thrower);
        Object.defineProperty(ErrorEvent.prototype, 'message', thrower);
        let cancelled: boolean;
        try {
            cancelled = raise(onError, 'Error: thrown');
        } finally {
            for (const [name, descriptor] of saved) Object.defineProperty(ErrorEvent.prototype, name, descriptor);
        }
        expect(cancelled).toBe(true);
        expect(lines).toEqual([['Uncaught Error: thrown']]);
    });

    it("positive control: a muted error (WebKit's, no error object and 'Script error.') is left to the view; any other is cancelled", () => {
        const { onError, lines } = start();
        const muted = trusted(new ErrorEvent('error', { message: 'Script error.', error: null, cancelable: true }));
        onError(muted);
        expect(muted.defaultPrevented).toBe(false);
        expect(raise(onError, 'Error: plain')).toBe(true);
        expect(lines).toEqual([['Uncaught Error: plain']]);
    });
});

describe("M-2 (class P): the view's time budget charges every operation in full", () => {
    const RATES = VIEW_OPTIONS.rates;

    it('the rates are the documented constants', () => {
        expect(RATES).toEqual({ characters: VIEW_RENDER_CHARACTERS_PER_SECOND, time: VIEW_APPLY_MS_PER_SECOND, urls: VIEW_URLS_PER_SECOND });
        expect(VIEW_OPTIONS.maxOperation).toBe(VIEW_MAX_OPERATION_MS);
    });

    it('an operation of 1.5 s, and one of 7.5 s, are charged all they took: the next waits five times their cost, less what the budget held', () => {
        for (const cost of [1500, 7500]) {
            const budget = viewBudget(RATES, 0);
            budget.charge('time', cost, 0);
            expect(budget.held('time', 0)).toBe(RATES.time - cost); // no floor (it was -1000 at 60814b5)
            expect(budget.owes(0)).toBe(true);
            expect(budget.wait(0, 0)).toBe(Math.ceil(((cost - RATES.time) / RATES.time) * 1000));
            const repaid = ((cost - RATES.time) / RATES.time) * 1000;
            expect(budget.owes(repaid - 1)).toBe(true);
            expect(budget.owes(repaid + 1)).toBe(false);
        }
    });

    it('a bucket holds at most one second of its rate, and refills at its rate', () => {
        const budget = viewBudget(RATES, 0);
        expect(budget.held('urls', 60000)).toBe(RATES.urls);
        budget.charge('urls', 3 * RATES.urls, 60000);
        expect(budget.wait(0, 60000)).toBe(2000);
        expect(budget.held('urls', 61000)).toBe(-RATES.urls);
        // characters: the wait covers what the next operation needs on top of the debt
        budget.charge('characters', RATES.characters, 70000);
        expect(budget.wait(RATES.characters / 2, 70000)).toBe(500);
        expect(budget.held('characters', 69000)).toBe(0); // a clock that goes back refills nothing
    });

    // The view's loop, as arithmetic: an operation runs once the budget owes nothing, and is charged what it took.
    const share = (costs: number[]) => {
        const budget = viewBudget(RATES, 0);
        let now = 0;
        let busy = 0;
        for (const cost of costs) {
            now += budget.wait(0, now);
            budget.charge('time', cost, now + cost);
            now += cost;
            busy += cost;
        }
        return { busy, elapsed: now + budget.wait(0, now) };
    };

    it('the long-run share is the budget, whatever the operations cost up to VIEW_MAX_OPERATION_MS', () => {
        // never more than one second's worth ahead of the rate, from the start
        for (const cost of [10, 199, 1000, 1500, VIEW_MAX_OPERATION_MS]) {
            const { busy, elapsed } = share(Array(40).fill(cost));
            expect(busy, String(cost)).toBeLessThanOrEqual(RATES.time + (elapsed * RATES.time) / 1000);
        }
        // operations of 1.5 s, one after the other: 1.5 s in every 8 s, 18.75% (with the floor, 1.5 s in 6.5 s: 23%;
        // operations of 7.5 s, 7.5 s in 12.5 s: 60%)
        const { busy, elapsed } = share(Array(40).fill(1500));
        expect(busy / elapsed).toBeCloseTo(1500 / 8000, 2);
        let seed = 1;
        const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let run = 0; run < 200; run++) {
            const costs = Array.from({ length: 30 }, () => Math.ceil(random() * VIEW_MAX_OPERATION_MS));
            const { busy, elapsed } = share(costs);
            expect(busy).toBeLessThanOrEqual(RATES.time + (elapsed * RATES.time) / 1000);
        }
    });

    it('the reason the host gives says the limit', () => {
        const host = readFileSync(join(__dirname, '../../src/host.ts'), 'utf8');
        expect(host).toContain(`const VIEW_OVERRUN_REASON = 'the view spent more than ${VIEW_MAX_OPERATION_MS} ms on one operation';`);
    });
});

describe('L-2 and N-7 (docs and class P): with allowAnimations false, what happens to a style attribute depends on its text alone', () => {
    // The renderer with `allowAnimations: false`; the attribute each <p> ends with, and how many CSSOM reads it took.
    const still = (styles: string[]) => {
        const template = document.createElement('template');
        template.innerHTML = styles.map(style => `<p style="${style.replace(/"/g, '&quot;')}"></p>`).join('');
        const read = vi.spyOn(CSSStyleDeclaration.prototype, 'getPropertyValue');
        try {
            sanitizeRender(template.content, () => null, () => false, RENDER_RULES, { animations: false, autoplay: true, stylesheets: true });
            return { styles: [...template.content.querySelectorAll('p')].map(p => p.getAttribute('style')), reads: read.mock.calls.length };
        } finally {
            read.mockRestore();
        }
    };

    it('a text without "animation", "transition" or a backslash is never read, "transform" and "transparent" included (N-7: they were)', () => {
        const written = ['transform: rotate(1deg); color: transparent', 'text-transform: uppercase', 'background: transparent; animatable: x'];
        const { styles, reads } = still(written);
        expect(styles).toEqual(written);
        expect(reads).toBe(0);
    });

    it('`all` beside an animation or a transition: the attribute goes, however it is written (L-2: Chromium kept "all: unset;")', () => {
        const { styles } = still([
            'all: unset; animation: spin 1s',
            'ALL :unset;transition: color 1s',
            '/* x */all/**/:unset; animation: spin 1s',
            'color: red;all:inherit; -webkit-animation: spin 1s',
        ]);
        expect(styles).toEqual([null, null, null, null]);
    });

    it('a backslash beside an animation: the attribute goes; `all` inside a comment or a string, or as part of a name, decides nothing', () => {
        const { styles } = still([
            'anim\\61tion: spin 1s',
            'color: red; /* all: unset */ animation: spin 1s',
            'font-family: "all: x"; animation: spin 1s',
            '--all: 1; animation: spin 1s; color: red',
        ]);
        expect(styles[0]).toBeNull();
        for (const style of styles.slice(1)) {
            expect(style).not.toBeNull();
            expect(style).not.toMatch(/animation/);
        }
        expect(styles[1]).toMatch(/color: red/);
    });

    it('the docs say so', () => {
        const api = readFileSync(join(__dirname, '../../docs/API.md'), 'utf8').replace(/\s+/g, ' ');
        expect(api).toContain('whose text contains neither `animation` nor `transition` (in any case) nor a backslash is left exactly as written');
        expect(api).not.toContain('declares more properties than it has characters');
    });
});

describe('M-4 (class P): one view loads at most VIEW_MAX_DISTINCT_URLS distinct URLs', () => {
    // The view in jsdom (which loads nothing), with a limit of 4 and every rate high enough not to hold a render back.
    const originalWorker = (globalThis as any).Worker;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        delete (globalThis as any).__sandboxViewRuns;
        document.body.replaceChildren();
    });
    async function startView() {
        const workers: { transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            constructor() { workers.push(this as any); }
            onerror: unknown = null;
            transfer: MessagePort[] = [];
            postMessage(_message: unknown, transfer: MessagePort[]) { this.transfer = transfer; }
        };
        const options: ViewOptions = { ...VIEW_OPTIONS, maxDistinctUrls: 4, rates: { characters: 1e9, time: 1e9, urls: 1e9 } };
        new Function(viewBootstrapSource(options))();
        const logic = new MessageChannel(), view = new MessageChannel();
        const html = '<div id="a"></div><div id="b"></div>';
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html, allowAnimations: true, origins: { images: ['https://a.example'] } }, source: window, ports: [logic.port1, view.port1] }));
        const render = workers[0]!.transfer[1]!;
        const acks: any[] = [];
        render.onmessage = (event) => { if (event.data?.type === 'VIEW_ACK') acks.push(event.data); };
        render.postMessage({ type: 'VIEW_STARTED', entryErrors: 0 });
        const send = async (markup: string, into: string) => {
            const before = acks.length;
            render.postMessage({ type: 'VIEW_RENDER', html: markup, into });
            for (let i = 0; i < 400 && acks.length === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
            return acks[acks.length - 1]?.refused ?? [];
        };
        return { send, close: () => { render.close(); view.port2.close(); logic.port2.close(); } };
    }
    const images = (...names: string[]) => names.map(name => `<img src="https://a.example/${name}.png">`).join('');

    it('up to the limit renders apply, a URL seen before costs nothing, one past the limit is refused whole, and said', async () => {
        const { send, close } = await startView();
        expect(await send(images('1', '2', '2', '3'), 'a')).toEqual([]); // three distinct, one repeated
        // the limit: a relative URL and a fragment are no new URL
        expect(await send(images('1', '4') + '<img src="x.png"><img src="https://a.example/4.png#f">', 'b')).toEqual([]);
        expect(document.querySelectorAll('img')).toHaveLength(8);
        expect(await send(images('1', '5'), 'b')).toEqual(['VIEW_MAX_DISTINCT_URLS']);
        expect(document.querySelectorAll('#b img')).toHaveLength(4); // nothing of it was applied
        // replacing what the view holds frees nothing: the limit is over the view's life
        expect(await send('', 'a')).toEqual([]);
        expect(await send(images('6'), 'a')).toEqual(['VIEW_MAX_DISTINCT_URLS']);
        // at the limit, URLs it loaded already still render, and so does CSS that names none; CSS that can name one does not
        expect(await send(images('1', '2', '3', '4'), 'a')).toEqual([]);
        expect(await send('<p style="color: red">x</p>', 'a')).toEqual([]);
        const css = ['<style>p{}</style>', '<p style="background: url(https://a.example/7.png)">x</p>', `<p style="background: image-set('https://a.example/8.png' 1x)">x</p>`];
        for (const markup of css) expect(await send(markup, 'a'), markup).toEqual(['VIEW_MAX_DISTINCT_URLS']);
        close();
    });

    it('the worker says why, with the limit', () => {
        expect(inStrictWorker.toString()).toMatch(/the view would load more than ["'] \+ options\.maxDistinctUrls \+ ["'] distinct URLs in this environment/);
    });
});
