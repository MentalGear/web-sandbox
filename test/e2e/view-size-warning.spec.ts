import { test, expect } from './fixture';

// The build with the network modes (ADR-009): strict mode's view is in the wrapper the element writes.
test.use({ build: 'network' });

/**
 * The wrapper-style warning (R1:R3-1) on every engine: it says the host page's style-src refuses the wrapper's style,
 * and the view finds that refusal itself, under the policies it inherits (in-sandbox-view.ts, wrapperStyleInForce). The
 * view's size at its check-in is no evidence: the frame's size reaches the view when the engine has laid the host page
 * out, which the check-in can precede.
 *
 * The test makes the check-in precede the frame's size, by construction and not by timing: the element is 150 px high
 * while the view checks in, and the host page grows it to 400 px in the element's own handler of that check-in, before
 * the element reads it (the page's own code wraps the element's handler; a host page's script reaches the element's
 * members, design 01). So the view's reading, 150 px, is right when taken and stale when judged. With the size as the
 * evidence the element warned; with the view's own finding it does not. A host page whose style-src does refuse the
 * wrapper's style still warns once: test/e2e/directive-matrix.spec.ts (`wrapperStyle`).
 */
test("strict mode: a check-in read before the frame grew warns nothing", async ({ sandbox, page }) => {
    const warnings: string[] = [];
    page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
    await page.evaluate(() => {
        const el = document.querySelector('web-sandbox') as any;
        el.style.display = 'block';
        el.style.height = '150px';
        const prototype = Object.getPrototypeOf(el);
        const original = prototype._onViewMessage;
        prototype._onViewMessage = function (this: any, port: unknown, data: any) {
            if (data && data.type === 'VIEW_READY') {
                (window as any).checkedInAt = data.height;
                this.style.height = '400px';
                (window as any).frameAtJudgment = this._iframe.clientHeight;
            }
            return Reflect.apply(original, this, [port, data]);
        };
    });
    expect(await sandbox.mount({ mode: 'strict' })).toBe('ready');
    // the precondition the test made: the reading was 150 px at most, and the frame was taller when it was judged
    const [checkedInAt, frameAtJudgment] = await page.evaluate(() => [(window as any).checkedInAt, (window as any).frameAtJudgment]);
    expect(checkedInAt).toBeLessThanOrEqual(150);
    expect(frameAtJudgment).toBe(400);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
    expect(warnings.filter(text => text.includes("refuses the wrapper's style"))).toEqual([]);
});
