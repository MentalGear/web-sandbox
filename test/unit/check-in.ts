import { BRIDGE_FRAME_OPTIONS, inBridgeFrame } from '@src/lib/in-bridge-frame';

/**
 * The guest's check-in, played by hand where jsdom cannot deliver it: jsdom loads no srcdoc document, so no guest frame
 * announces itself and no strict view checks in. The completion of a build is the lifecycle reducer's (S65)
 * (src/lib/lifecycle.ts: `announced`, `viewReady`, `frameLoad`), so this steps the input the platform would give the
 * standing build, through the element's private `_step`, and the reducer decides the rest as it does in a browser:
 * - strict mode: the view's check-in (`viewReady`), with `port` as the guest's logic port (the element would have made
 *   it at the wrapper's load, `_setupStrictChannels`, and handed the other end to the view);
 * - a guest whose bootstrap announces its port (cooperative mode with allow-scripts, worker mode): its announcement
 *   (`announced`), carrying `port`;
 * - a guest with no bootstrap: the wrapper's load (`frameLoad`); there is no port then, and `port` is not used.
 */
const GUEST_WINDOW = Object.freeze({ guestWindow: true }); // the guest frame's window, as the reducer compares it

export function checkIn(el: any, port: unknown): void {
    const build = el._lc.build;
    const gen = el._lc.gen;
    if (build?.strict) {
        el.setupChannel(port);
        el._step({ t: 'viewReady', gen, height: null, stillStyleRefused: false });
        return;
    }
    if (build?.announces) {
        el._step({ t: 'announced', gen, valid: true, refusal: null, port, source: GUEST_WINDOW });
        return;
    }
    el._step({ t: 'frameLoad', gen, stillOurs: true, guest: GUEST_WINDOW });
}

/**
 * The fetch bridge's frame, played by hand where jsdom cannot run it (it loads no srcdoc document, and no script in a
 * frame): the frame's own code (in-bridge-frame.ts, inBridgeFrame) runs in the test's realm, its fetch the realm's
 * (stub it before calling this), and is handed the bridge frame's port as the frame's load would hand it (bridge-frame.ts,
 * createBridgeFrame). Call it right after the build that made the frame, before anything awaits.
 */
export function playBridgeFrame(el: any): void {
    const root: ParentNode = el.shadowRoot ?? el;
    const frame = root.querySelector('iframe[aria-hidden="true"]') as HTMLIFrameElement | null;
    if (!frame) throw new Error('no bridge frame');
    const g = globalThis as any;
    const run = (data: unknown, transfer: unknown[]) => {
        const saved = g.addEventListener;
        let listener: ((event: unknown) => void) | null = null;
        g.addEventListener = (_type: string, given: (event: unknown) => void) => { listener = given; };
        delete g.__sandboxBridgeRuns;
        try {
            inBridgeFrame(BRIDGE_FRAME_OPTIONS);
        } finally {
            g.addEventListener = saved;
        }
        listener!({ source: g.parent, data, ports: transfer, stopImmediatePropagation() {} });
    };
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: (data: unknown, _origin: string, transfer: unknown[]) => run(data, transfer) } });
    (frame.onload as ((event: Event) => void) | null)?.(new Event('load'));
}
