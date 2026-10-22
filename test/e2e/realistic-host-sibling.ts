import type http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface SiblingHit { name: string; method: string; host: string; headers: http.IncomingHttpHeaders }

/**
 * Another API of the application, on another port (realistic-host.ts): reached as `https://localhost:P` it is on the
 * host page's site (the registrable domain `localhost`), and receives the host's cookies in the engines that send them;
 * reached as `https://127.0.0.1:P` it is on another site. One listener, so a test sees both; CORS for any origin. It is
 * https, with a certificate made per run for both names (a spec that starts it sets `ignoreHTTPSErrors`): the library's
 * policy upgrades insecure requests, and WebKit upgrades even a loopback `http:` URL.
 */
export async function startSiblingApi() {
    const hits: SiblingHit[] = [];
    const dir = mkdtempSync(path.join(tmpdir(), 'sibling-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const tls = { key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) };
    const server = https.createServer(tls, (req, res) => {
        const url = new URL(req.url ?? '/', 'https://sibling');
        hits.push({ name: url.pathname.replace(/^\/api\//, ''), method: req.method ?? '', host: String(req.headers.host), headers: { ...req.headers } });
        const image = url.pathname.endsWith('.svg');
        res.writeHead(req.method === 'OPTIONS' ? 204 : 200, {
            'content-type': image ? 'image/svg+xml' : 'application/json',
            'access-control-allow-origin': '*',
            'access-control-allow-methods': '*',
            'access-control-allow-headers': '*',
            'cross-origin-resource-policy': 'cross-origin',
        });
        res.end(req.method === 'OPTIONS' ? undefined : image ? '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="5"></svg>' : JSON.stringify({ sibling: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        /** On the host page's site, another origin. */
        sameSite: `https://localhost:${port}`,
        /** On another site. */
        crossSite: `https://127.0.0.1:${port}`,
        hits,
        named: (name: string) => hits.filter(hit => hit.name === name),
        stop: async () => {
            await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
