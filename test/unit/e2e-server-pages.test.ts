// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/**
 * The pages of the e2e server load no dev client (vite.config.ts, withoutDevClient). Vite adds its client to every HTML
 * file it serves, and the client opens the HMR socket; the e2e server has no socket, so a client left in a page fails
 * to connect and says so in the page's console, in each engine's own words and at a time of its own. A spec that asserts
 * a clean console would then need a list of those words. Here: every HTML file of the checkout, as the e2e server
 * serves it, names no dev client; and as `bun run dev` serves it, it does (the control: the tag is what Vite adds).
 */

const ROOT = resolve(import.meta.dirname, '../..');
const CONFIG = join(ROOT, 'vite.config.ts');
const DEV_CLIENT = '/@vite/client';
// Directories no page under test is served from: dependencies, build outputs, nested checkouts.
const SKIPPED = new Set(['node_modules', '.git', '.claude', 'dist', 'dist-network', 'dist-playground', 'temp', 'out', 'test-results']);

/** Every HTML file under `directory`, as paths relative to the checkout's root. */
function htmlFiles(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (SKIPPED.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...htmlFiles(path));
        if (entry.isFile() && entry.name.endsWith('.html')) found.push(relative(ROOT, path));
    }
    return found;
}

/** The server of vite.config.ts, as the e2e run starts it (`e2e`) or as `bun run dev` does, listening on no port. */
async function serverOf(e2e: boolean): Promise<ViteDevServer> {
    const before = process.env.WEB_SANDBOX_E2E;
    if (e2e) process.env.WEB_SANDBOX_E2E = '1';
    else delete process.env.WEB_SANDBOX_E2E;
    try {
        return await createServer({ root: ROOT, configFile: CONFIG, logLevel: 'silent', server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true } });
    } finally {
        if (before === undefined) delete process.env.WEB_SANDBOX_E2E;
        else process.env.WEB_SANDBOX_E2E = before;
    }
}

const served = (server: ViteDevServer, file: string) => server.transformIndexHtml(`/${file}`, readFileSync(join(ROOT, file), 'utf8'));

describe('the e2e server: its pages load no dev client', () => {
    const FILES = htmlFiles(ROOT);
    let e2eServer: ViteDevServer;
    let devServer: ViteDevServer;

    beforeAll(async () => {
        e2eServer = await serverOf(true);
        devServer = await serverOf(false);
    });
    afterAll(async () => {
        await e2eServer?.close();
        await devServer?.close();
    });

    test('the harness pages are among the files', () => {
        expect(FILES).toEqual(expect.arrayContaining(['test/e2e/harness.html', 'test/e2e/package-harness.html']));
    });

    test('no HTML file names the dev client as the e2e server serves it', async () => {
        const naming: string[] = [];
        for (const file of FILES) {
            if ((await served(e2eServer, file)).includes(DEV_CLIENT)) naming.push(file);
        }
        expect(naming).toEqual([]);
    });

    test('control: every HTML file names it as the dev server serves it', async () => {
        const without: string[] = [];
        for (const file of FILES) {
            if (!(await served(devServer, file)).includes(DEV_CLIENT)) without.push(file);
        }
        expect(without).toEqual([]);
    });
});
