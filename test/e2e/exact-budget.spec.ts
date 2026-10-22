import fc from 'fast-check';
import { test, expect } from './fixture';
import type { MountConfig, SandboxDriver } from './fixture';
import { useRecorder } from './recorder';

useRecorder();

/**
 * S77, S78 (class P): the byte budgets count what is delivered, on Chromium, Firefox and WebKit. The measure is run on
 * the browser's own clones (a File's name and a Blob's type are copied whole by the clone, and Node's structuredClone
 * does not stand for that: test/unit/measure-delivered.test.ts runs the same property on built values), and a guest
 * that sends an oversized File name or a sparse array meets the budgets that already exist.
 */

const MODES: Record<string, MountConfig> = {
    cooperative: { mode: 'cooperative' },
    worker: { mode: 'worker' },
    strict: { mode: 'strict', scriptUnsafe: true },
};

type Case = { kind: 'file' | 'blob' | 'sparse'; nameLength: number; typeLength: number; modified: number; length: number; at: number[]; wrap: 'none' | 'array' | 'object' | 'map' };

const cases = fc.record({
    kind: fc.constantFrom('file', 'blob', 'sparse'),
    nameLength: fc.oneof(fc.integer({ min: 0, max: 64 }), fc.integer({ min: 0, max: 400000 })),
    typeLength: fc.oneof(fc.integer({ min: 0, max: 64 }), fc.integer({ min: 0, max: 100000 })),
    modified: fc.integer({ min: 0, max: 2 ** 40 }),
    length: fc.oneof(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 2 ** 24 })),
    at: fc.array(fc.nat(99), { maxLength: 4 }),
    wrap: fc.constantFrom('none', 'array', 'object', 'map'),
}) as fc.Arbitrary<Case>;

test.describe('S77: the measure counts at least what the browser delivers, for every supported kind', () => {
    test('a File, a Blob and a sparse array, alone or inside an array, an object or a Map, through a real MessageChannel', async ({ sandbox, page }) => {
        test.setTimeout(60000);
        const samples = fc.sample(cases, { numRuns: 60, seed: 77 });
        // the extremes by hand: a name and a type at the length of a limit's worth, and a sparse array of many slots (WebKit's
        // clone of one of 2**28 slots never arrives, so what is delivered here stays within 2**24)
        samples.push(
            { kind: 'file', nameLength: 2 ** 21, typeLength: 0, modified: 1, length: 0, at: [], wrap: 'none' },
            { kind: 'blob', nameLength: 0, typeLength: 2 ** 20, modified: 0, length: 0, at: [], wrap: 'array' },
            { kind: 'sparse', nameLength: 0, typeLength: 0, modified: 0, length: 2 ** 24, at: [5], wrap: 'object' },
            { kind: 'file', nameLength: 2 ** 20, typeLength: 2 ** 20, modified: 2 ** 40, length: 0, at: [], wrap: 'map' },
        );
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
                let leaf: unknown;
                if (c.kind === 'file') leaf = new File(['x'], 'n'.repeat(c.nameLength), { type: 'a/' + 'b'.repeat(Math.min(c.typeLength, 1 << 20)), lastModified: c.modified });
                else if (c.kind === 'blob') leaf = new Blob(['x'], { type: 'a/' + 'b'.repeat(c.typeLength) });
                else { const sparse: unknown[] = []; sparse.length = c.length; for (const i of c.at) if (i < c.length) sparse[i] = 1; leaf = sparse; }
                const value = c.wrap === 'array' ? [leaf] : c.wrap === 'object' ? { k: leaf } : c.wrap === 'map' ? new Map([['k', leaf]]) : leaf;
                const received = await deliver(value) as any;
                const part = c.wrap === 'array' ? received[0] : c.wrap === 'object' ? received.k : c.wrap === 'map' ? received.get('k') : received;
                // what arrived, field by field, in the units of the budgets: two bytes a code unit, 8 a number, 8 a slot
                let delivered = 0;
                if (c.kind === 'file') delivered = 2 * part.name.length + 2 * part.type.length + 8;
                else if (c.kind === 'blob') delivered = 2 * part.type.length;
                else delivered = 8 * part.length;
                if (c.kind === 'sparse' && part.length !== c.length) failed.push(`${c.kind}: length ${part.length} arrived for ${c.length}`);
                if (c.kind === 'file' && part.name.length !== c.nameLength) failed.push(`file: a name of ${part.name.length} arrived for ${c.nameLength}`);
                const measured = sizeOf(received, Infinity);
                if (!(measured >= delivered)) failed.push(`${c.kind}/${c.wrap}: measured ${measured} for ${delivered} delivered`);
                // and within a limit the measure says "past" whenever the delivered size is past it
                const limit = 1048576;
                if (delivered > limit && !(sizeOf(received, limit) > limit)) failed.push(`${c.kind}/${c.wrap}: ${delivered} delivered is past ${limit} and the measure says it is not`);
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

// Chromium drops a Blob's type when it is long (measured: kept at 1 000 characters, dropped at 100 000), Firefox and WebKit
// keep it whole, so there the clone delivers it and here it delivers nothing to count.
const keepsLongTypes = (sandbox: SandboxDriver) => sandbox.inGuest<boolean>(`return new Blob([], { type: 'a/' + 'b'.repeat(2 ** 25) }).type.length > 2 ** 24`);

for (const [mode, config] of Object.entries(MODES)) {
    test.describe(`S77: ${mode} mode: an oversized File name or a sparse array meets the existing budgets`, () => {
        test('a log line: a File with a name past LOG_MAX_BYTES and a sparse array arrive as the budget\'s placeholder, and the line after them at once', async ({ sandbox }) => {
            expect(await sandbox.mount(config)).toBe('ready');
            const typeKept = await keepsLongTypes(sandbox);
            await sandbox.run(`
                const sparse = []; sparse.length = 2 ** 18; sparse[5] = 1; // 2 MiB at 8 bytes a slot
                console.log('S77 file', new File([], 'x'.repeat(2 ** 21)));
                console.log('S77 blob', new Blob([], { type: 'a/' + 'b'.repeat(2 ** 21) }));
                console.log('S77 sparse', sparse);
                console.log('S77 nested', { list: [new File([], 'y'.repeat(2 ** 21))] });
                console.log('S77 after', new File(['x'], 'photo.png', { type: 'image/png' }).name);`);
            expect(await sandbox.waitForLog(/^S77 file /)).toBe("S77 file [File: past the log line's byte budget (1048576)]");
            expect(await sandbox.waitForLog(/^S77 blob /)).toBe(typeKept ? "S77 blob [Blob: past the log line's byte budget (1048576)]" : 'S77 blob [object Blob]');
            expect(await sandbox.waitForLog(/^S77 sparse /)).toBe("S77 sparse [Array: past the log line's byte budget (1048576)]");
            expect(await sandbox.waitForLog(/^S77 nested /)).toMatch(/^S77 nested \[Object: past the log line's byte budget/);
            expect(await sandbox.waitForLog('S77 after photo.png')).toBe('S77 after photo.png');
        });

        test('a call to a host method: past RPC_MAX_BYTES by a File name, a Blob type or a sparse array, the guest\'s own broker refuses it; a small File is delivered', async ({ sandbox }) => {
            test.setTimeout(60000);
            expect(await sandbox.mount(config)).toBe('ready');
            const typeKept = await keepsLongTypes(sandbox);
            await sandbox.exposeHost('sink', '(...args) => args.length');
            await sandbox.exposeHost('nameOf', '(file) => [file.name, file.type, file.lastModified]');
            const outcome = await sandbox.inGuest(`
                const refused = async (...args) => { try { await bridge.call('sink', ...args); return 'sent'; } catch (error) { return error.code; } };
                const sparse = []; sparse.length = 2 ** 23; sparse[5] = 1; // 64 MiB at 8 bytes a slot
                return [
                    await refused(new File([], 'x'.repeat(2 ** 25))),
                    await refused(new Blob([], { type: 'a/' + 'b'.repeat(2 ** 25) })),
                    await refused(sparse),
                    await refused({ deep: [sparse] }),
                    await bridge.call('nameOf', new File(['x'], 'photo.png', { type: 'image/png', lastModified: 1234 })),
                ];`, 30000);
            expect(outcome).toEqual(['ARGS_NOT_TRANSFERABLE', typeKept ? 'ARGS_NOT_TRANSFERABLE' : 'sent', 'ARGS_NOT_TRANSFERABLE', 'ARGS_NOT_TRANSFERABLE', ['photo.png', 'image/png', 1234]]);
        });

        test('a result of the guest\'s method: a File with an oversized name or a sparse array is refused as RESULT_NOT_TRANSFERABLE, and a small one is delivered', async ({ sandbox }) => {
            test.setTimeout(60000);
            expect(await sandbox.mount(config)).toBe('ready');
            await sandbox.exposeGuest('bigFile', `() => new File([], 'x'.repeat(2 ** 25))`);
            await sandbox.exposeGuest('sparse', `() => { const a = []; a.length = 2 ** 23; a[5] = 1; return a; }`);
            await sandbox.exposeGuest('small', `() => [new File(['x'], 'photo.png', { type: 'image/png' }), new Blob([], { type: 'text/plain' })].map(file => [file.name ?? null, file.type])`);
            expect(await sandbox.callOutcome('bigFile')).toMatchObject({ status: 'rejected', code: 'RESULT_NOT_TRANSFERABLE' });
            expect(await sandbox.callOutcome('sparse')).toMatchObject({ status: 'rejected', code: 'RESULT_NOT_TRANSFERABLE' });
            expect(await sandbox.callOutcome('small')).toEqual({ status: 'resolved', value: [['photo.png', 'image/png'], [null, 'text/plain']] });
            expect(await sandbox.state()).toBe('ready');
        });
    });
}
