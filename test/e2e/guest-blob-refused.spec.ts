import { test, expect, buildOfMode, type MountConfig } from './fixture';

/**
 * No `Blob` or `File` crosses from the guest (I7, design 02): the measure of a guest value (structured-size.ts) refuses
 * both, at any depth, before anything is handed to the embedder's code, on every engine, in sealed mode (the default
 * build) and in strict mode (the build with the network modes). Each arrival: a host method's arguments (the method never
 * runs), the result of `call()` and `callWithTimeout()`, and a log line's arguments (no `sandbox-log` detail holds one).
 * The guest's own broker and console relay run the same measure, stringified into its realm, and refuse first; the
 * host's own measure of what arrives, for a guest that skips them, is unit-tested (test/unit/snapshot-kinds.test.ts).
 */

const MODES: Record<string, MountConfig> = {
    sealed: { mode: 'sealed' },
    strict: { mode: 'strict' },
};

// What the guest makes, by name: a Blob and a File alone, and nested in each container.
const KINDS = `{
    blob: () => new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>parent.alert(1)</script></svg>'], { type: 'image/svg+xml' }),
    file: () => new File(['<p>x</p>'], 'invoice.pdf.exe', { type: 'text/html' }),
    inObject: () => ({ attachment: { blob: new Blob(['x'], { type: 'text/html' }) } }),
    inArray: () => [1, new File(['x'], 'a.svg', { type: 'image/svg+xml' })],
    inMap: () => new Map([['k', new Blob(['x'])]]),
    asMapKey: () => new Map([[new File(['x'], 'k'), 1]]),
    inSet: () => new Set([new Blob(['x'])]),
}`;
const NAMES = ['blob', 'file', 'inObject', 'inArray', 'inMap', 'asMapKey', 'inSet'];

for (const [mode, config] of Object.entries(MODES)) {
    test.describe(`${mode} mode`, () => {
        test.use({ build: buildOfMode(mode) });

        test(`${mode} mode: a guest's Blob or File, alone or in an object, an array, a Map or a Set, reaches no code of the embedder's`, async ({ sandbox, page }) => {
            // Every value a host method receives and every log line's raw arguments, scanned for a Blob or a File at any depth.
            await page.evaluate(() => {
                const holds = (value: unknown, seen = new Set<unknown>()): boolean => {
                    if (value instanceof Blob) return true;
                    if (typeof value !== 'object' || value === null || seen.has(value)) return false;
                    seen.add(value);
                    if (value instanceof Map) return [...value].some(([k, v]) => holds(k, seen) || holds(v, seen));
                    if (value instanceof Set) return [...value].some(v => holds(v, seen));
                    return Object.values(value).some(v => holds(v, seen));
                };
                const w = window as any;
                w.__blobsSeen = [];
                w.__taken = [];
                w.__holds = holds;
                window.addEventListener('sandbox-log', (event) => {
                    const args = (event as CustomEvent).detail.args as unknown[];
                    if (holds(args)) w.__blobsSeen.push('sandbox-log');
                }, true);
            });
            await sandbox.exposeHost('take', `(...args) => { if (window.__holds(args)) window.__blobsSeen.push('take'); window.__taken.push(args.length); return 'taken'; }`);
            const sent = await sandbox.inEntry<Record<string, string>>(config, `
                const kinds = ${KINDS};
                for (const [name, make] of Object.entries(kinds)) bridge.expose('give_' + name, () => make());
                bridge.expose('give_bytes', () => ({ attachment: new TextEncoder().encode('<p>x</p>') }));
                const calls = {};
                for (const [name, make] of Object.entries(kinds)) {
                    try { await bridge.call('take', 'before', make()); calls[name] = 'sent'; } catch (error) { calls[name] = error.code; }
                }
                for (const [name, make] of Object.entries(kinds)) console.log('I7-LOG ' + name, make());
                console.log('I7-LOG bytes', new TextEncoder().encode('x'));
                calls.bytes = await bridge.call('take', { attachment: new TextEncoder().encode('<p>x</p>') }).then(() => 'sent', (error) => error.code);
                return calls;`);

            // a host method's arguments: refused before the method runs; the control, bytes, arrives
            const refusedCalls: Record<string, string> = { bytes: 'sent' };
            for (const name of NAMES) refusedCalls[name] = 'ARGS_NOT_TRANSFERABLE';
            expect(sent).toEqual(refusedCalls);
            expect(await page.evaluate(() => (window as any).__taken)).toEqual([1]);

            // the result of call() and callWithTimeout(): refused; the control resolves with the bytes
            for (const name of NAMES) {
                expect(await sandbox.callOutcome(`give_${name}`), name).toMatchObject({ status: 'rejected', code: 'RESULT_NOT_TRANSFERABLE' });
                expect(await sandbox.callWithTimeoutOutcome(5000, `give_${name}`), name).toMatchObject({ status: 'rejected', code: 'RESULT_NOT_TRANSFERABLE' });
            }
            expect(await page.evaluate(async () => {
                const value = await (document.querySelector('web-sandbox') as any).call('give_bytes') as { attachment: unknown };
                return Object.prototype.toString.call(value.attachment);
            })).toBe('[object Uint8Array]');

            // a log line's arguments: each arrives as the string that names the kind, never as the value
            await sandbox.waitForLog('I7-LOG bytes');
            const lines = (await sandbox.logs()).filter(line => line.startsWith('I7-LOG '));
            const blobs = lines.filter(line => !line.startsWith('I7-LOG bytes'));
            expect(blobs.map(line => line.split(' ')[1])).toEqual(NAMES);
            for (const line of blobs) expect(line).toMatch(/^I7-LOG \w+ \[unsupported value: (Blob|File)\]$/);

            // and no code of the embedder's was handed one, anywhere
            expect(await page.evaluate(() => (window as any).__blobsSeen)).toEqual([]);
            expect(await sandbox.state()).toBe('ready');
        });
    });
}
