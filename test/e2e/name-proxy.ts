import http from 'node:http';
import net, { type AddressInfo } from 'node:net';

/**
 * The names' resolver for specs that need several sites on one machine (`app.wsprobe.test`, `cdn.wsprobe.test`, …): an
 * HTTP proxy that tunnels a CONNECT to any `.test` host to the same port on 127.0.0.1 and refuses everything else. A
 * spec's context uses it (`proxy`), on every engine, for every host but localhost and 127.0.0.1, so the browser never
 * resolves the names itself and no DNS entry is needed; one HTTPS listener with a certificate for the names answers
 * them all.
 */
export async function startNameProxy() {
    const server = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
    const tunnels = new Set<net.Socket>(); // a tunnel leaves the server's connections: closed by stop() itself
    server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
        tunnels.add(client);
        client.on('close', () => tunnels.delete(client));
        const target = /^([a-z0-9.-]+\.test):(\d+)$/i.exec(req.url ?? '');
        if (!target) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
        const upstream = net.connect(Number(target[2]), '127.0.0.1', () => {
            tunnels.add(upstream);
            upstream.on('close', () => tunnels.delete(upstream));
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        stop: () => new Promise<void>(resolve => {
            server.close(() => resolve());
            server.closeAllConnections();
            for (const socket of tunnels) socket.destroy();
        }),
    };
}
