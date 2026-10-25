import { test, expect } from './fixture';
import type { Page } from '@playwright/test';
import type { SandboxConfig } from '@src/host';
import { GATE_SOURCE_FILE } from '@src/lib/violation';
import { useRecorder } from './recorder';
import { inFrames, inView, waitInView } from './strict-view';

/**
 * Sealed mode (docs/research/24_sealed_mode), opt-in with `mode: 'sealed'`: strict mode's view and worker with no
 * network. A smoke test on every engine: a sealed sandbox renders and runs an app from its files, as an embedder
 * configures it (setConfig() itself, no baseline and no scriptUnsafe); a guest request is refused and reported and the
 * listener sees nothing, while the same request from strict mode with the listener in `origins` reaches it (positive
 * control); and a sealed config that names `origins` is refused with its reason. Evidence from outside the library
 * (strict-view.ts): the frames, the view's policy and body.
 */

const recorder = useRecorder();

const REASON = "origins and fetchBridge open the network, which sealed mode does not have: set `mode: 'strict'`";

/** Applies `config` exactly as given (no baseline) and resolves with 'ready' or 'terminated'. */
const apply = (page: Page, config: SandboxConfig) => page.evaluate((c) => whenSettled(s => s.setConfig(c)), config as any);

const APP = `
sandboxView.render('<h1 id="hello">Hello</h1><p id="count">0</p>', 'root');
let count = 0;
bridge.expose('add', (n) => { count += n; sandboxView.text('count', String(count)); return count; });
`;

test.describe('sealed mode', () => {
    test('renders and runs: an entry from the files draws the view and answers a call; the view holds only the hashed bootstrap under a policy with no network source', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.registerFiles({ 'main.js': APP, 'style.css': 'h1 { color: rgb(1, 2, 3); }' })).toBe('ok');
        expect(await apply(page, { mode: 'sealed', entry: 'main.js', html: '<link rel="stylesheet" href="style.css"><div id="root"></div>' })).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('hello')`, 8000);
        expect(await sandbox.call('add', 2)).toBe(2);
        expect(await sandbox.call('add', 3)).toBe(5);
        await waitInView(page, browserName, `document.getElementById('count').textContent === '5'`);
        expect((await inFrames(page, browserName, '1')).map(f => f.path)).toEqual(['main', 'main/wrapper', 'main/wrapper/view']);
        const view = await inView<{ scripts: number; policy: string; color: string }>(page, browserName, `({
            scripts: document.scripts.length,
            policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
            color: getComputedStyle(document.getElementById('hello')).color,
        })`);
        expect(view).toEqual({
            scripts: 1,
            policy: expect.stringMatching(/^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]{43}='; script-src-attr 'none'; style-src 'unsafe-inline' blob:; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src blob:;/),
            color: 'rgb(1, 2, 3)', // the registered stylesheet, through its blob: URL
        });
        expect(await sandbox.state()).toBe('ready');
    });

    test('no network: a guest fetch is refused and reported by the request gate, sandboxFetch() is FETCH_NOT_ALLOWED, and the listener sees nothing; strict mode with the listener in origins reaches it (positive control)', async ({ sandbox }) => {
        const probe = (path: string) => `
            const fetched = await fetch('${recorder.allowed}${path}').then(() => 'sent', (e) => e.name);
            const bridged = await sandboxFetch('${recorder.allowed}${path}-bridge').then(() => 'sent', (e) => e.code);
            return { fetched, bridged };
        `;
        expect(await sandbox.mount({ mode: 'sealed' })).toBe('ready');
        expect(await sandbox.inGuest(probe('/sealed'))).toEqual({ fetched: 'TypeError', bridged: 'FETCH_NOT_ALLOWED' });
        await expect.poll(async () => (await sandbox.violations()).filter(v => v.sourceFile === GATE_SOURCE_FILE).map(v => v.blockedURI)).toEqual([`${recorder.allowed}/sealed`]);
        await sandbox.page.waitForTimeout(500);
        expect(recorder.paths('allowed')).toEqual([]);

        expect(await sandbox.mount({ mode: 'strict', origins: { connect: [recorder.allowed] } })).toBe('ready');
        expect((await sandbox.inGuest(probe('/strict'))).fetched).toBe('sent');
        await recorder.waitFor('allowed', '/strict');
    });

    test('a sealed config that names origins is refused: terminated with the reason, and a sealed config without it builds again', async ({ sandbox, page }) => {
        void sandbox;
        expect(await apply(page, { mode: 'sealed', origins: { images: [recorder.allowed] } } as unknown as SandboxConfig)).toBe('terminated');
        expect((await sandbox.terminations()).at(-1)!.reason).toBe(REASON);
        expect(await apply(page, { mode: 'sealed', html: '<p>ok</p>' })).toBe('ready');
    });
});
