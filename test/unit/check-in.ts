/**
 * The guest's check-in, played by hand where jsdom cannot deliver it: jsdom loads no srcdoc document, so no guest frame
 * announces itself and no strict view checks in. Since S65's PR D the completion of a build is the lifecycle reducer's
 * (src/lib/lifecycle.ts: `announced`, `viewReady`, `frameLoad`), so this steps the input the platform would give the
 * standing build, through the element's private `_step`, and the reducer decides the rest as it does in a browser:
 * - strict mode: the view's check-in (`viewReady`), with `port` as the guest's logic port (the element would have made
 *   it at the wrapper's load, `_setupStrictChannels`, and handed the other end to the view);
 * - a guest whose bootstrap announces its port (cooperative mode with allow-scripts, worker mode): its announcement
 *   (`announced`), carrying `port`;
 * - a guest with no bootstrap: the wrapper's load (`frameLoad`); there is no port then, and `port` is not used.
 * Before PR D the tests called the element's `_finishBuild(port)`, which completed any build with any port.
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
