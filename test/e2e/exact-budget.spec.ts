import fc from 'fast-check';
import { test, expect, buildOfMode } from './fixture';
import type { MountConfig, SandboxDriver } from './fixture';
import { useRecorder } from './recorder';

// The build with the network modes (ADR-009): this file's tests mount them. A sealed test names the default build.
test.use({ build: 'network' });

useRecorder();

/**
 * S77, S78 (class P): the byte budgets count what is delivered, on Chromium, Firefox and WebKit. The measure is run on
 * the browser's own clones (test/unit/measure-delivered.test.ts runs the same property on built values), and a guest
 * that sends a sparse array of a large `length` meets the budgets that already exist. A `Blob` or a `File` is not of the
 * measure's kinds at all (I7): test/e2e/guest-blob-refused.spec.ts.
 */

const MODES: Record<string, MountConfig> = {
    cooperative: { mode: 'cooperative' },
    worker: { mode: 'worker' },
    strict: { mode: 'strict', scriptUnsafe: true },
    sealed: { mode: 'sealed', scriptUnsafe: true },
};

type Case = { length: number; at: number[]; wrap: 'none' | 'array' | 'object' | 'map' };

const cases = fc.record({
    length: fc.oneof(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 2 ** 24 })),
    at: fc.array(fc.nat(99), { maxLength: 4 }),
    wrap: fc.constantFrom('none', 'array', 'object', 'map'),
}) as fc.Arbitrary<Case>;

test.describe('S77: the measure counts at least what the browser delivers, for a sparse array', () => {
    test('a sparse array, alone or inside an array, an object or a Map, through a real MessageChannel', async ({ sandbox, page }) => {
        test.setTimeout(60000);
        const samples = fc.sample(cases, { numRuns: 60, seed: 77 });
        // the extreme by hand: a sparse array of many slots (WebKit's clone of one of 2**28 slots never arrives, so what is
        // delivered here stays within 2**24)
        samples.push({ length: 2 ** 24, at: [5], wrap: 'object' });
        await sandbox.mount(MODES.strict);
        const failures = await page.evaluate(async (all) => {
            const module = '/src/lib/structured-size.ts'; // served by the e2e server, as the harness's own imports
            const { createSizeOf } = await import(/* @vite-ignore */ module) as typeof import('@src/lib/structured-size');
            const sizeOf = createSizeOf();
            const deliver = (value: unknown) => new Promise<unknown>((resolve) => {
                const { port1, port2 } = new MessageChannel();
                port2.onmessage = (event) => { port1.close(); port2.close(); resolve(event.data); };
                port1.postMessage(value);
            });
            const failed: string[] = [];
            for (const c of all) {
                const leaf: unknown[] = [];
                leaf.length = c.length;
                for (const i of c.at) if (i < c.length) leaf[i] = 1;
                const value = c.wrap === 'array' ? [leaf] : c.wrap === 'object' ? { k: leaf } : c.wrap === 'map' ? new Map([['k', leaf]]) : leaf;
                const received = await deliver(value) as any;
                const part = c.wrap === 'array' ? received[0] : c.wrap === 'object' ? received.k : c.wrap === 'map' ? received.get('k') : received;
                // what arrived, in the units of the budgets: 8 a slot
                const delivered = 8 * part.length;
                if (part.length !== c.length) failed.push(`length ${part.length} arrived for ${c.length}`);
                const measured = sizeOf(received, Infinity);
                if (!(measured >= delivered)) failed.push(`${c.wrap}: measured ${measured} for ${delivered} delivered`);
                // and within a limit the measure says "past" whenever the delivered size is past it
                const limit = 1048576;
                if (delivered > limit && !(sizeOf(received, limit) > limit)) failed.push(`${c.wrap}: ${delivered} delivered is past ${limit} and the measure says it is not`);
            }
            return failed;
        }, samples);
        expect(failures).toEqual([]);
    });

    test('a sparse array of 2**32 - 1 slots, as built (no clone of it): past every limit, answered at once', async ({ sandbox, page }) => {
        await sandbox.mount(MODES.strict);
        const sizes = await page.evaluate(async () => {
            const module = '/src/lib/structured-size.ts';
            const { createSizeOf } = await import(/* @vite-ignore */ module) as typeof import('@src/lib/structured-size');
            const sizeOf = createSizeOf();
            const sparse: unknown[] = [];
            sparse.length = 2 ** 32 - 1;
            sparse[5] = 1;
            return [sizeOf(sparse, 1048576), sizeOf(sparse, 34603008), sizeOf({ list: [sparse] }, 1048576)];
        });
        for (const size of sizes) expect(size).toBeGreaterThan(34603008);
    });
});

for (const [mode, config] of Object.entries(MODES)) {
    test.describe(`${mode} mode`, () => {
    test.use({ build: buildOfMode(mode) });
    test.describe(`S77: ${mode} mode: a sparse array meets the existing budgets`, () => {
        test('a log line: a sparse array past LOG_MAX_BYTES arrives as the budget\'s placeholder, nested too, and the line after it at once', async ({ sandbox }) => {
            expect(await sandbox.mount(config)).toBe('ready');
            await sandbox.run(`
                const sparse = []; sparse.length = 2 ** 18; sparse[5] = 1; // 2 MiB at 8 bytes a slot
                console.log('S77 sparse', sparse);
                console.log('S77 nested', { list: [sparse] });
                console.log('S77 after', 'photo.png');`);
            expect(await sandbox.waitForLog(/^S77 sparse /)).toBe("S77 sparse [Array: past the log line's byte budget (1048576)]");
            expect(await sandbox.waitForLog(/^S77 nested /)).toMatch(/^S77 nested \[Object: past the log line's byte budget/);
            expect(await sandbox.waitForLog('S77 after photo.png')).toBe('S77 after photo.png');
        });

        test('a call to a host method: past RPC_MAX_BYTES by a sparse array, the guest\'s own broker refuses it; a small one is delivered', async ({ sandbox }) => {
            test.setTimeout(60000);
            await sandbox.exposeHost('sink', '(...args) => args.length');
            await sandbox.exposeHost('lengthOf', '(list) => list.length');
            expect(await sandbox.mount(config)).toBe('ready');
            const outcome = await sandbox.inGuest(`
                const refused = async (...args) => { try { await bridge.call('sink', ...args); return 'sent'; } catch (error) { return error.code; } };
                const sparse = []; sparse.length = 2 ** 23; sparse[5] = 1; // 64 MiB at 8 bytes a slot
                const small = []; small.length = 1000; small[5] = 1;
                return [await refused(sparse), await refused({ deep: [sparse] }), await bridge.call('lengthOf', small)];`, 30000);
            expect(outcome).toEqual(['ARGS_NOT_TRANSFERABLE', 'ARGS_NOT_TRANSFERABLE', 1000]);
        });

        test('a result of the guest\'s method: a sparse array past the budget is refused as RESULT_NOT_TRANSFERABLE, and a small one is delivered', async ({ sandbox }) => {
            test.setTimeout(60000);
            expect(await sandbox.mount(config)).toBe('ready');
            await sandbox.exposeGuest('sparse', `() => { const a = []; a.length = 2 ** 23; a[5] = 1; return a; }`);
            await sandbox.exposeGuest('small', `() => { const a = []; a.length = 1000; a[5] = 1; return a.length; }`);
            expect(await sandbox.callOutcome('sparse')).toMatchObject({ status: 'rejected', code: 'RESULT_NOT_TRANSFERABLE' });
            expect(await sandbox.callOutcome('small')).toEqual({ status: 'resolved', value: 1000 });
            expect(await sandbox.state()).toBe('ready');
        });
    });
    });
}
