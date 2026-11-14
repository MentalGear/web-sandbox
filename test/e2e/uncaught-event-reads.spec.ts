import { test, expect, type SandboxDriver } from './fixture';
import { VIEW_MODES } from './view-modes';

/**
 * BD1:TST-1 (class G, with E-cpu): the bootstrap's `error` and `unhandledrejection` listeners read the event through the
 * platform's getters, captured before guest code runs (readEvent), so a guest that replaces
 * `PromiseRejectionEvent.prototype.reason` or `ErrorEvent.prototype`'s `message` and `error` cannot make the library count
 * a small string for a report whose real, large text the browser makes of it (Firefox reports every worker rejection to
 * the host page's thread, cancelled or not: R5:N-1). The budget of uncaught characters still ends the sandbox, with its
 * reason, in every mode that has the listeners: worker mode, strict mode and sealed mode (the cooperative mode's
 * listeners only relay: test/unit/egress.test.ts). The control runs the same flood without the replaced accessor.
 * test/unit/event-reads.test.ts scans that no listener reads a member of its event.
 */

const UNCAUGHT_REASON = /uncaught errors or unhandled rejections/;
const BIG = `const big = 'x'.repeat(2 * 1024 * 1024);`; // 2 Mi characters: past the budget of UNCAUGHT_CHARACTERS_PER_SECOND at the first

const FLOODS = {
    'rejections': (replaced: boolean) => `${replaced ? `Object.defineProperty(PromiseRejectionEvent.prototype, 'reason', { get() { return 'x'; }, configurable: true });` : ''}
        ${BIG} for (let i = 0; i < 3; i++) Promise.reject(new Error(big));`,
    // strict and sealed mode: an uncaught error while the entry runs ends the sandbox as its failure, so these are raised after it
    'uncaught errors': (replaced: boolean) => `${replaced ? `Object.defineProperty(ErrorEvent.prototype, 'message', { get() { return 'x'; }, configurable: true });
        Object.defineProperty(ErrorEvent.prototype, 'error', { get() { return undefined; }, configurable: true });` : ''}
        ${BIG} setTimeout(() => { for (let i = 0; i < 3; i++) reportError(new Error(big)); }, 50);`, // after the entry: an error during it is the entry's failure
};

// Worker mode has no entry: its guest code arrives through execute(). Strict and sealed mode run the entry.
async function raise(sandbox: SandboxDriver, mode: 'worker' | (typeof VIEW_MODES)[number], code: string) {
    if (mode === 'worker') {
        expect(await sandbox.mount({ mode: 'worker', scriptUnsafe: true })).toBe('ready');
        await sandbox.run(code);
        return;
    }
    expect(await sandbox.registerFiles({ 'main.js': code })).toBe('ok');
    await sandbox.mount({ mode, entry: 'main.js' }); // 'ready', or 'terminated' if the flood ended it first
}

for (const mode of ['worker', ...VIEW_MODES] as const) {
    test.describe(`${mode} mode`, () => {
        for (const [name, flood] of Object.entries(FLOODS)) {
            for (const replaced of [false, true]) {
                test(`three ${name} of 2 Mi characters ${replaced ? 'with the event accessors the listener reads replaced by the guest' : '(control: nothing replaced)'} end the sandbox with the uncaught-budget reason`, async ({ sandbox, browserName }) => {
                    // WebKit mutes the text of a worker's uncaught error ("Script error.", no error object): there is no large message for the
                    // bootstrap's error listener to read, and in the view modes the view counts the muted error instead, so the effect this
                    // spec looks for is not there, and the same flood ends the sandbox with or without the listener's read
                    // ledger: webkit-muted-errors
                    test.skip(browserName === 'webkit' && name === 'uncaught errors', 'WebKit mutes the text of a worker\'s uncaught error');
                    test.setTimeout(60000);
                    await raise(sandbox, mode, flood(replaced));
                    await expect.poll(async () => (await sandbox.terminations()).map(termination => termination.reason), { timeout: 20000 }).toEqual([expect.stringMatching(UNCAUGHT_REASON)]);
                    expect(await sandbox.state()).toBe('terminated');
                });
            }
        }
    });
}
