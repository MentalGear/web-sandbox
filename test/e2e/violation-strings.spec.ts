import { test, expect } from './fixture';

/**
 * A violation report's strings are cut before they are posted (class E-cpu, "cut before posting"; backlog S61.3's scan,
 * test/unit/structural.test.ts): the bootstrap and the view cut `directive`, `blockedURI` and `sourceFile` at
 * VIOLATION_MAX_STRING (2048), so a URL the guest chose never crosses whole to the host page, which cuts them again on
 * receipt (violation.ts). Measured on every engine: what the report arrives as on the host page's port, raw, before the
 * element reads it, and what the `violation` event says.
 */

const ATTACKER = 'https://attacker.test';
const MAX = 2048;
const LONG = 100000;

type Raw = { directive: number; blockedURI: number; sourceFile: number; start: string };

test.beforeEach(async ({ page }) => {
    // The host page's ports, as the element sets their onmessage: each VIOLATION frame is recorded as it arrives, raw.
    await page.addInitScript(() => {
        if (window !== window.top) return;
        const raw: unknown[] = [];
        Object.defineProperty(window, 'rawViolations', { value: raw });
        const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')!;
        Object.defineProperty(MessagePort.prototype, 'onmessage', {
            ...descriptor,
            set(this: MessagePort, handler: ((event: MessageEvent) => void) | null) {
                descriptor.set!.call(this, handler && ((event: MessageEvent) => {
                    const data = event.data;
                    if (data && data.type === 'VIOLATION') {
                        const length = (value: unknown) => (typeof value === 'string' ? value.length : -1);
                        raw.push({ directive: length(data.directive), blockedURI: length(data.blockedURI), sourceFile: length(data.sourceFile), start: String(data.blockedURI).slice(0, 40) });
                    }
                    handler(event);
                }));
            },
        });
    });
});

const CASES = [
    { name: 'cooperative mode, a fetch of a long https URL', mode: 'cooperative' as const, prefix: `${ATTACKER}/long-`, run: `fetch('${ATTACKER}/long-' + 'a'.repeat(${LONG}), { mode: 'no-cors' }).catch(() => {}); console.log('sent')` },
    { name: 'cooperative mode, a fetch of a long data: URL', mode: 'cooperative' as const, prefix: 'data', run: `fetch('data:text/plain,' + 'a'.repeat(${LONG})).catch(() => {}); console.log('sent')` },
    { name: 'cooperative mode, an image from a blob: URL whose path is long', mode: 'cooperative' as const, prefix: 'blob', run: `const i = new Image(); i.src = URL.createObjectURL(new Blob(['x'])) + '#' + 'a'.repeat(${LONG}); console.log('sent')` },
    { name: 'strict mode, the worker\'s fetch of a long https URL', mode: 'strict' as const, prefix: `${ATTACKER}/long-`, run: `fetch('${ATTACKER}/long-' + 'a'.repeat(${LONG})).catch(() => {}); console.log('sent')` },
    { name: 'strict mode, the view\'s image of a long https URL', mode: 'strict' as const, prefix: `${ATTACKER}/long-`, run: `sandboxView.render('<img src="${ATTACKER}/long-' + 'a'.repeat(${LONG}) + '">'); console.log('sent')` },
];

for (const { name, mode, prefix, run } of CASES) {
    test(`${name}: the report crosses cut at ${MAX} characters, and the event says the same`, async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({ mode })).toBe('ready');
        await sandbox.run(run);
        await sandbox.waitForLog('sent');
        await page.waitForTimeout(1500);
        const raw: Raw[] = await page.evaluate(() => [...(window as any).rawViolations]);
        const events = (await sandbox.violations()).map(v => ({ directive: v.directive, blockedURI: v.blockedURI.length, start: v.blockedURI.slice(0, 40), source: v.source }));
        console.log(`MEASURED ${browserName} ${name}: raw ${JSON.stringify(raw)}; events ${JSON.stringify(events)}`);
        // whatever an engine reports (some reduce a data: or blob: URL to its scheme, some raise nothing in a worker),
        // nothing crosses longer than the cut, raw or as an event
        for (const frame of raw) {
            expect(frame.blockedURI, JSON.stringify(frame)).toBeLessThanOrEqual(MAX);
            expect(frame.sourceFile, JSON.stringify(frame)).toBeLessThanOrEqual(MAX);
            expect(frame.directive, JSON.stringify(frame)).toBeLessThanOrEqual(MAX);
        }
        for (const event of events) expect(event.blockedURI).toBeLessThanOrEqual(MAX);
        // a report of the long URL itself is cut to exactly the limit, its start kept
        for (const frame of raw) if (frame.start.startsWith(prefix) && prefix.startsWith('https')) expect(frame.blockedURI).toBe(MAX);
    });
}
