import { test, expect, type SandboxDriver } from './fixture';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A guest's request to the http: or ws: form of a listed https: or wss: origin is refused by every engine, and nothing
 * reaches the server in cleartext (docs/API.md#origins; INHERITED_CONTEXT.cspFetch). No guest policy carries
 * `upgrade-insecure-requests`: the engines disagreed on what it does to such a request (Chromium refused it, WebKit upgraded
 * it, Firefox sent it as written, from a worker and to a loopback host), so a policy that carried it admitted a different
 * request in each. Evidence is the listener's, outside the browser: a plain-http server that counts every connection, request
 * and upgrade it receives. The positive control is the listed https: form of the same origin, which opens a connection to the
 * very same server (its TLS handshake fails there, so the guest sees a refusal too: it is the connection that counts).
 */

interface Plain { server: Server; origin: string; connections: number; requests: string[]; upgrades: string[] }

async function plainServer(): Promise<Plain> {
    const state: Plain = { server: createServer(), origin: '', connections: 0, requests: [], upgrades: [] };
    state.server.on('connection', (socket) => { state.connections++; socket.on('error', () => {}); });
    state.server.on('request', (request, response) => { state.requests.push(`${request.method} ${request.url}`); response.writeHead(200, { 'access-control-allow-origin': '*' }).end('plain'); });
    state.server.on('upgrade', (request, socket) => { state.upgrades.push(request.url ?? ''); socket.destroy(); });
    await new Promise<void>(resolve => state.server.listen(0, '127.0.0.1', resolve));
    state.origin = `127.0.0.1:${(state.server.address() as AddressInfo).port}`;
    return state;
}

async function mount(sandbox: SandboxDriver, mode: 'strict' | 'worker' | 'cooperative', host: string) {
    const config: Record<string, unknown> = { mode, scriptUnsafe: true, origins: { connect: [`https://${host}`, `wss://${host}`] } };
    if (mode === 'strict') {
        await sandbox.registerFiles({ 'main.js': 'void 0' });
        config.entry = 'main.js';
    }
    if (mode === 'cooperative') config.capabilities = ['allow-scripts'];
    expect(await sandbox.mount(config as any)).toBe('ready');
}

/** What each request API of the guest does with the http: or ws: form of the listed origin: 'refused', or 'ok'. */
const REQUESTS = (host: string) => `
    const settle = (promise) => promise.then(() => 'ok', () => 'refused');
    const xhr = (url) => new Promise((resolve) => {
        try { const request = new XMLHttpRequest(); request.open('GET', url); request.onload = () => resolve('ok'); request.onerror = () => resolve('refused'); request.send(); } catch (error) { resolve('refused'); }
    });
    const socket = (url) => new Promise((resolve) => {
        try { const ws = new WebSocket(url); ws.onopen = () => { resolve('ok'); ws.close(); }; ws.onerror = () => resolve('refused'); setTimeout(() => resolve('timeout'), 3000); } catch (error) { resolve('refused'); }
    });
    return {
        fetch: await settle(fetch('http://${host}/plain-fetch', { cache: 'no-store' })),
        xhr: await xhr('http://${host}/plain-xhr'),
        socket: await socket('ws://${host}/plain-socket'),
    };`;

for (const mode of ['strict', 'worker', 'cooperative'] as const) {
    test(`${mode} mode: the http: and ws: forms of a listed https: and wss: origin are refused, and nothing reaches the server in cleartext`, async ({ sandbox, page }) => {
        const plain = await plainServer();
        try {
            await mount(sandbox, mode, plain.origin);
            expect(await sandbox.inGuest(REQUESTS(plain.origin)), 'every request API refuses').toEqual({ fetch: 'refused', xhr: 'refused', socket: 'refused' });
            await page.waitForTimeout(400);
            expect(plain.requests, 'no plaintext request').toEqual([]);
            expect(plain.upgrades, 'no plaintext WebSocket handshake').toEqual([]);
            expect(plain.connections, 'no connection at all: not as written, and not upgraded to a TLS attempt either').toBe(0);

            // positive control: the listed https: form opens a connection to the same server (its handshake fails there)
            await sandbox.inGuest(`await fetch('https://${plain.origin}/listed', { cache: 'no-store' }).catch(() => {}); return 1;`);
            await expect.poll(() => plain.connections, { message: 'the listed https: form reaches the server' }).toBeGreaterThan(0);
            expect(plain.requests, 'and the server still saw no plaintext request').toEqual([]);
        } finally {
            plain.server.closeAllConnections();
            await new Promise(resolve => plain.server.close(resolve));
        }
    });
}
