import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from './fixture';

/**
 * An evidence channel outside the browser for egress specs (backlog T5): two HTTPS listeners on loopback,
 * recording every request and WebSocket handshake that reaches them.
 *
 *   ALLOWED  a spec puts this origin in the guest policy, for its positive controls
 *   BLOCKED  no policy names it: the target of every attempt that must not leave the sandbox
 *
 * Unlike Playwright's request routing, which in Chromium saw guest-frame requests only intermittently
 * (blob-delivery probe, T5), a socket cannot miss a request that reached it. Silence on BLOCKED is still
 * only evidence once ALLOWED has shown, in the same spec file, that the same kind of load does arrive:
 * every file that uses the recorder carries such a positive control.
 *
 * Both are HTTPS on 127.0.0.1 (upgrade-insecure-requests is always on, and WebKit upgrades even a
 * loopback http: URL), with a certificate made per run; specs that use it set ignoreHTTPSErrors.
 * Responses are permissive (CORS *) and typed by extension, so a load that arrives also succeeds and the
 * guest's own outcome agrees with the listener. A `.js` file counts its runs in globalThis.__recorderRan.
 */

export type Hit = { server: 'allowed' | 'blocked'; path: string; method: string; websocket: boolean };

const CONTENT_TYPES: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
};
const BODIES: Record<string, string> = {
    '.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="5"></svg>',
    '.js': 'globalThis.__recorderRan = (globalThis.__recorderRan || 0) + 1;',
    '.css': 'body { --recorder: 1; }',
    '.html': '<!DOCTYPE html><p>recorder</p>',
};
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class Recorder {
    readonly hits: Hit[] = [];
    allowed = '';
    blocked = '';
    private servers: https.Server[] = [];
    private sockets = new Set<Duplex>(); // upgraded WebSocket connections, which server.close() would wait for
    private certDir = '';

    async start() {
        this.certDir = mkdtempSync(path.join(tmpdir(), 'recorder-cert-'));
        const key = path.join(this.certDir, 'key.pem');
        const cert = path.join(this.certDir, 'cert.pem');
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
            '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
        const tls = { key: readFileSync(key), cert: readFileSync(cert) };
        this.allowed = await this.listen('allowed', tls);
        this.blocked = await this.listen('blocked', tls);
    }

    async stop() {
        for (const socket of this.sockets) socket.destroy();
        await Promise.all(this.servers.map(server => {
            const closed = new Promise(resolve => server.close(resolve));
            server.closeAllConnections(); // keep-alive connections from the browser would hold close() open
            return closed;
        }));
        if (this.certDir) rmSync(this.certDir, { recursive: true, force: true });
    }

    clear() {
        this.hits.length = 0;
    }

    /** Paths that reached one listener, in order. */
    paths(server: Hit['server']): string[] {
        return this.hits.filter(hit => hit.server === server).map(hit => hit.path);
    }

    /** Waits until `server` has seen a request whose path starts with `prefix` (the positive controls). */
    async waitFor(server: Hit['server'], prefix: string, timeout = 5000) {
        await expect.poll(() => this.paths(server).some(p => p.startsWith(prefix)), { timeout, message: `${server} listener never saw ${prefix}` }).toBe(true);
    }

    private async listen(server: Hit['server'], tls: { key: Buffer; cert: Buffer }): Promise<string> {
        const httpsServer = https.createServer(tls, (req, res) => {
            const url = new URL(req.url ?? '/', 'https://recorder');
            this.hits.push({ server, path: url.pathname + url.search, method: req.method ?? '', websocket: false });
            const extension = path.extname(url.pathname);
            res.writeHead(200, { 'content-type': CONTENT_TYPES[extension] ?? 'text/plain', 'access-control-allow-origin': '*' });
            res.end(BODIES[extension] ?? 'ok');
        });
        // A WebSocket handshake is answered too, so a socket that reaches a listener opens in the guest.
        httpsServer.on('upgrade', (req, socket) => {
            const url = new URL(req.url ?? '/', 'https://recorder');
            this.hits.push({ server, path: url.pathname + url.search, method: req.method ?? '', websocket: true });
            const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + WEBSOCKET_GUID).digest('base64');
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
            socket.on('error', () => this.sockets.delete(socket));
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        });
        this.servers.push(httpsServer);
        await new Promise<void>(resolve => httpsServer.listen(0, '127.0.0.1', resolve));
        return `https://127.0.0.1:${(httpsServer.address() as AddressInfo).port}`;
    }
}

/**
 * Starts a recorder for the spec file that calls this (at module level), cleared before each test.
 * Sets ignoreHTTPSErrors, since its certificate is self-signed.
 */
export function useRecorder(): Recorder {
    const recorder = new Recorder();
    test.use({ ignoreHTTPSErrors: true });
    test.beforeAll(() => recorder.start());
    test.afterAll(() => recorder.stop());
    test.beforeEach(() => recorder.clear());
    return recorder;
}

/** The wss:// form of a recorder origin. */
export const wss = (origin: string) => origin.replace(/^https:/, 'wss:');
