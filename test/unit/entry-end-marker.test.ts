import { describe, it, expect, afterEach } from 'vitest';
import { inStrictWorker, VIEW_OPTIONS, viewBootstrapSource } from '@src/lib/in-sandbox-view';

/**
 * Backlog S75 (class B, a browser decision re-derived): which of the Worker object's errors are the strict entry's own
 * (they end the sandbox, "the guest entry failed to start") and which are later (logged). The view used to read the end
 * of the entry from VIEW_STARTED, on the render port, a second channel, on the prediction that an error which reaches it
 * before VIEW_STARTED can only be the entry's. WebKit refutes it: it mutes the errors of code compiled from a string
 * (execute(), Function, eval) in the worker from the start, so they reach the Worker object, and one raised after the
 * entry ran reached the view before VIEW_STARTED did (PR #47's CI: review-round-1.spec.ts, "strict mode: a later uncaught
 * error …", WebKit; an entry's queueMicrotask of such code: always). Now the line after the entry raises the build's
 * marker error, and the view reads the end of the entry from the order of the Worker object's errors alone.
 *
 * Each case here failed before S75: the view posted GUEST_ERROR for the marker and for every error before VIEW_STARTED.
 */

const MARKER = '__sandboxEntryRan_0123456789abcdef0123456789abcdef';

describe("S75: the view tells the entry's errors from later ones by the marker error, in the order of the Worker object's errors", () => {
    const originalWorker = (globalThis as any).Worker;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        delete (globalThis as any).__sandboxViewRuns;
    });

    // The real view bootstrap in jsdom, with a stand-in Worker whose onerror the test calls as the browser would.
    const startView = () => {
        const workers: any[] = [];
        (globalThis as any).Worker = class {
            constructor() { workers.push(this); }
            onerror: unknown = null;
            transfer: MessagePort[] = [];
            postMessage(_message: unknown, transfer: MessagePort[]) { this.transfer = transfer; }
        };
        new Function(viewBootstrapSource(VIEW_OPTIONS))();
        const logic = new MessageChannel(), view = new MessageChannel();
        const toHost: any[] = [];
        view.port2.onmessage = (event) => toHost.push(event.data);
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', entryDone: MARKER, viewFiles: [], html: '' }, source: window, ports: [logic.port1, view.port1] }));
        const worker = workers[0]!;
        const render: MessagePort = worker.transfer[1]!;
        const settle = () => new Promise(resolve => setTimeout(resolve, 20));
        const errors: { message: string; cancelled: boolean }[] = [];
        const raise = (message: string) => {
            const record = { message, cancelled: false };
            errors.push(record);
            worker.onerror({ message, preventDefault() { record.cancelled = true; } });
        };
        const started = async () => { render.postMessage({ type: 'VIEW_STARTED' }); await settle(); };
        const verdicts = async () => {
            await settle();
            return toHost.filter(frame => frame.type === 'GUEST_ERROR' || frame.type === 'GUEST_UNCAUGHT').map(frame => `${frame.type} ${frame.message}`);
        };
        const close = () => { render.close(); view.port2.close(); logic.port2.close(); };
        return { raise, started, verdicts, errors, close };
    };

    // The engines' texts for the marker error on the Worker object (Chromium; Firefox and WebKit).
    for (const markerText of [`Uncaught Error: ${MARKER}`, `Error: ${MARKER}`]) {
        // Every place VIEW_STARTED can arrive among the errors of an entry that ran: before them, between any two, after
        // them, or not yet. The verdicts are the same in each.
        for (let at = 0; at <= 4; at++) {
            it(`an entry that ran (marker "${markerText.slice(0, 16)}…"), VIEW_STARTED ${at === 4 ? 'never' : `after ${at} of the 3 errors`}: two later errors, logged; the marker, cancelled and posted nowhere`, async () => {
                const { raise, started, verdicts, errors, close } = startView();
                const sequence = [markerText, 'Error: later one', 'Error: later two'];
                for (let i = 0; i < sequence.length; i++) {
                    if (at === i) await started();
                    raise(sequence[i]!);
                }
                if (at === 3) await started();
                expect(await verdicts()).toEqual(['GUEST_UNCAUGHT Error: later one', 'GUEST_UNCAUGHT Error: later two']);
                expect(errors.map(error => error.cancelled)).toEqual([true, true, true]);
                close();
            });
        }
    }

    for (const at of [0, 1, 2]) {
        it(`an entry that threw at its top level (no marker), VIEW_STARTED ${at === 2 ? 'never' : `after ${at} of its errors`}: its error is the entry's, and so is every error after it`, async () => {
            const { raise, started, verdicts, close } = startView();
            const sequence = ['Error: entry broke', 'Error: from its timer'];
            for (let i = 0; i < sequence.length; i++) {
                if (at === i) await started();
                raise(sequence[i]!);
            }
            expect(await verdicts()).toEqual(['GUEST_ERROR Error: entry broke', 'GUEST_ERROR Error: from its timer']);
            close();
        });
    }

    it("the marker is looked for only until it came: a later error with its text is a later error, logged", async () => {
        const { raise, verdicts, close } = startView();
        raise(`Error: ${MARKER}`);
        raise(`Error: ${MARKER}`);
        expect(await verdicts()).toEqual([`GUEST_UNCAUGHT Error: ${MARKER}`]);
        close();
    });

    it("and only where the engines put it: the marker's name deep in a long text is not the marker", async () => {
        const { raise, verdicts, close } = startView();
        raise(`Error: ${'x'.repeat(200)}${MARKER}`);
        expect(await verdicts()).toEqual([`GUEST_ERROR Error: ${'x'.repeat(200)}${MARKER}`]);
        close();
    });

    it('an INIT_VIEW without the marker: no error is taken for it, so every error is the entry\'s (the side that ends the sandbox)', async () => {
        const workers: any[] = [];
        (globalThis as any).Worker = class {
            constructor() { workers.push(this); }
            onerror: unknown = null;
            transfer: MessagePort[] = [];
            postMessage(_message: unknown, transfer: MessagePort[]) { this.transfer = transfer; }
        };
        new Function(viewBootstrapSource(VIEW_OPTIONS))();
        const logic = new MessageChannel(), view = new MessageChannel();
        const toHost: any[] = [];
        view.port2.onmessage = (event) => toHost.push(event.data);
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html: '' }, source: window, ports: [logic.port1, view.port1] }));
        const worker = workers[0]!;
        worker.transfer[1]!.postMessage({ type: 'VIEW_STARTED' });
        await new Promise(resolve => setTimeout(resolve, 20));
        worker.onerror({ message: 'Error: anything', preventDefault() {} });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(toHost.filter(frame => frame.type === 'GUEST_ERROR').map(frame => frame.message)).toEqual(['Error: anything']);
        worker.transfer[1]!.close(); view.port2.close(); logic.port2.close();
    });
});

describe('S75: the strict prelude raises the marker error at the end of the entry, at once, and no listener of the guest sees it', () => {
    const implOf = (object: object): any => (object as any)[Object.getOwnPropertySymbols(object).find(symbol => symbol.description === 'impl')!];

    // The prelude, run as stringified with globalThis bound to a stand-in global whose reportError dispatches the error
    // event at once, as the engines' does (the error event, then its default action: here, recorded as "reached the view").
    // Dispatched as jsdom dispatches its own trusted events (dispatchEvent() would make it untrusted, as the DOM says).
    const start = (withReportError: boolean) => {
        const w = new EventTarget() as any;
        Object.assign(w, { URL: {} });
        const lines: unknown[][] = [];
        const reachedView: string[] = [];
        const raise = (error: Error) => {
            const event = new ErrorEvent('error', { message: `Error: ${error.message}`, error, cancelable: true });
            implOf(event).isTrusted = true;
            implOf(w)._dispatch(implOf(event));
            if (!event.defaultPrevented) reachedView.push(event.message);
        };
        if (withReportError) w.reportError = (error: Error) => raise(error);
        const run = new Function('globalThis', `return (${inStrictWorker.toString()})`)(w);
        run({ attach: () => {}, log: (_level: string, args: unknown[]) => lines.push(args) }, { scriptUnsafe: false, maxRender: 100, maxTarget: 5, maxElements: 100, maxDepth: 10, maxCharacters: 100, maxUrls: 10, maxDistinctUrls: 10, entryDoneName: MARKER, eventTypes: ['click'] });
        return { w, raise, lines, reachedView };
    };

    it("errors before the marker are the entry's: left alone, so they reach the view; the marker, reported through reportError before the call returns, reaches it too; later errors are cancelled and logged", () => {
        const { w, raise, lines, reachedView } = start(true);
        const seen: string[] = [];
        // the guest's own listeners, added by the entry (after the prelude's)
        w.addEventListener('error', (event: ErrorEvent) => seen.push(`capture ${event.message}`), true);
        w.addEventListener('error', (event: ErrorEvent) => seen.push(`bubble ${event.message}`));
        raise(new Error('entry broke'));
        expect(reachedView).toEqual(['Error: entry broke']);
        w[MARKER](); // the line after the entry: returns, the marker already reported
        expect(reachedView).toEqual(['Error: entry broke', `Error: ${MARKER}`]);
        raise(new Error('later'));
        expect(reachedView).toEqual(['Error: entry broke', `Error: ${MARKER}`]); // cancelled
        expect(lines).toEqual([['Uncaught Error: later']]);
        // the guest saw its own errors, never the marker
        expect(seen.filter(line => line.includes(MARKER))).toEqual([]);
        expect(seen).toEqual(['capture Error: entry broke', 'bubble Error: entry broke', 'capture Error: later', 'bubble Error: later']);
    });

    it('without reportError, the marker is thrown (the line after the entry is the last of the script)', () => {
        const { w } = start(false);
        expect(() => w[MARKER]()).toThrow(MARKER);
    });

    it("an error event that only says the marker's text is not the marker: the prelude stops only the marker error itself", () => {
        const { w, raise, lines, reachedView } = start(true);
        w[MARKER]();
        raise(new Error(MARKER)); // a guest's own Error with the marker's text: a later error like any other
        expect(reachedView).toEqual([`Error: ${MARKER}`]);
        expect(lines).toEqual([[`Uncaught Error: ${MARKER}`]]);
    });
});
