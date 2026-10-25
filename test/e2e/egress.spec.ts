import { test, expect, type SandboxDriver } from './fixture';
import { inFrames } from './strict-view';
import { EGRESS, REPORTED_EVENT_TYPES, type EgressMode, type EgressRealm } from '@src/lib/egress';
import { VIEW_MODES, type ViewMode } from './view-modes';

/**
 * The egress table, enumerated on every engine (class E-cpu, R5:N-1; src/lib/egress.ts): in each realm guest
 * activity can reach, every event-handler surface the engine has, its `on*` names on the global's prototype chain and on
 * the Worker and MessagePort interfaces, and the event types the platform reports without one, must be a row of the
 * table for that realm and mode. A new event type in a browser release fails here, and is classified, before a review
 * finds it.
 */

// The surfaces of the realm the expression runs in: the global's `on*` names (prototype chain included), and the Worker
// and MessagePort interfaces' (null where the realm has no such interface).
const SURFACES = `(() => {
    const names = (start) => {
        const found = new Set();
        for (let o = start; o; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) if (n.startsWith('on')) found.add(n.slice(2));
        return [...found].sort();
    };
    const of = (name) => (typeof globalThis[name] === 'function' ? names(globalThis[name].prototype) : null);
    return { global: names(globalThis), Worker: of('Worker'), MessagePort: of('MessagePort') };
})()`;

type Surfaces = { global: string[]; Worker: string[] | null; MessagePort: string[] | null };

const listed = (realm: EgressRealm, mode: EgressMode) => new Set(EGRESS.filter(row => row.realm === realm && row.modes.includes(mode)).map(row => row.surface));

// What `found` names that the table does not list for the realm, each with the known reported types added.
function unlisted(found: readonly string[] | null, realm: EgressRealm, mode: EgressMode, reported: readonly string[] = []): string[] {
    if (found === null) return [];
    const rows = listed(realm, mode);
    return [...new Set([...found, ...reported])].filter(surface => !rows.has(surface)).map(surface => `${realm}: ${surface}`);
}

async function mountMode(sandbox: SandboxDriver, mode: 'worker' | ViewMode) {
    if (mode === 'worker') {
        expect(await sandbox.mount({ mode: 'worker', scriptUnsafe: true })).toBe('ready');
        return;
    }
    await sandbox.registerFiles({ 'main.js': 'void 0' });
    expect(await sandbox.mount({ mode, entry: 'main.js', scriptUnsafe: true })).toBe('ready');
}

for (const mode of ['worker', ...VIEW_MODES] as const) {
    test(`${mode} mode: every surface of the guest's worker, of its parent document and of the Worker and MessagePort objects is a row of the egress table`, async ({ sandbox, page, browserName }) => {
        await mountMode(sandbox, mode);
        const worker = await sandbox.inGuest<Surfaces>(`return ${SURFACES};`);
        // the worker's parent document: worker mode's frame, the view of strict and sealed mode (main/wrapper/view either way)
        const parent = (await inFrames<Surfaces>(page, browserName, SURFACES, path => path === 'main/wrapper/view')).find(frame => frame.path === 'main/wrapper/view')?.value;
        expect(parent && parent !== 'no-context', 'the parent document was read').toBe(true);
        const document = parent as Surfaces;
        const missing = [
            ...unlisted(worker.global, 'worker', mode, ['error', 'unhandledrejection', 'rejectionhandled', 'messageerror', 'securitypolicyviolation', 'message']),
            ...unlisted(worker.MessagePort, 'port', mode, ['message', 'messageerror']),
            ...unlisted(document.global, mode === 'worker' ? 'frame' : 'view', mode, REPORTED_EVENT_TYPES),
            ...unlisted(document.Worker, 'worker-object', mode, ['error', 'message', 'messageerror']),
            ...unlisted(document.MessagePort, 'port', mode, ['message', 'messageerror']),
        ];
        console.log(`MEASURED ${browserName} ${mode} mode surfaces: worker ${worker.global.length}, its parent document ${document.global.length}, Worker ${JSON.stringify(document.Worker)}, MessagePort ${JSON.stringify(document.MessagePort)}`);
        expect(missing).toEqual([]);
    });
}
