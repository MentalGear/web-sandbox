// Research 21: the probe's listener and cookie jar (probe.spec.ts, view.spec.ts). One HTTPS listener answers for three
// host names that all resolve to 127.0.0.1 (one line in /etc/hosts, HOSTS_LINE), so the browser sees three sites:
//   H  app.wsprobe.test    the host page's own origin
//   S  cdn.wsprobe.test    a sibling subdomain of H: the host page's own site
//   X  cross.wsprobe2.test another site (what an embedder lists in `origins`)
// It records, per request, the Cookie names, Origin, Sec-Fetch-*, Range, the status it answered and the method.
import https from 'node:https';
import dns from 'node:dns/promises';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const HOSTS = { H: 'app.wsprobe.test', S: 'cdn.wsprobe.test', X: 'cross.wsprobe2.test' } as const;
export type Target = keyof typeof HOSTS;
export const HOSTS_LINE = `127.0.0.1 ${Object.values(HOSTS).join(' ')}`;

/**
 * The environment of this probe's browsers: the machine's, with the .test names added to the proxy bypass list (a
 * machine with HTTPS_PROXY would otherwise send them to the proxy). The specs pass it as their browsers' launch env and
 * never write process.env: Playwright imports every spec of a run, so a write there reaches every browser of the run.
 * The list has no empty entry: WebKit fails every page load under a NO_PROXY that has one and no proxy set.
 */
export function browserEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
    for (const name of ['NO_PROXY', 'no_proxy']) env[name] = [...(env[name] ?? '').split(','), '.test'].map(entry => entry.trim()).filter(Boolean).join(',');
    return env;
}

/** What the answer to a request carries: `cors` ACAO *, `nocors` no ACAO, `null` ACAO null, `creds` ACAO null + ACAC true. */
export type Acao = 'cors' | 'nocors' | 'null' | 'creds';

export type Hit = {
    method: string; host: string; path: string; k: string; cookies: string[]; origin: string; mode: string; dest: string; site: string;
    range: string; status: number; referer: string;
};

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAIAAAAPE8H1AAAAEElEQVR4nGP4z8AAQQxEsgCEuw7yxezkBQAAAABJRU5ErkJggg==', 'base64');
export function wav(seconds: number): Buffer {
    const samples = 8000 * seconds, b = Buffer.alloc(44 + samples * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), 44 + i * 2);
    return b;
}
const VTT = 'WEBVTT\n\n00:00.000 --> 00:05.000\nhello\n';
const FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf'];

/** A noise clip (incompressible, so ~7 MB): large enough that seeking far needs a Range request. null without ffmpeg. */
function webm(dir: string): Buffer | null {
    const file = `${dir}/v.webm`;
    try {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=25,geq=random(1)*255:128:128', '-t', '12', '-c:v', 'libvpx', '-b:v', '5M', '-minrate', '5M', '-maxrate', '5M', '-g', '25', '-an', file], { stdio: 'ignore' });
        return readFileSync(file);
    } catch { return null; }
}

export async function hostsResolve(): Promise<boolean> {
    try {
        for (const host of Object.values(HOSTS)) if ((await dns.lookup(host)).address !== '127.0.0.1') return false;
        return true;
    } catch { return false; }
}

export async function listener() {
    const dir = mkdtempSync(path.join(tmpdir(), 'xo-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=wsprobe', '-addext', `subjectAltName=${Object.values(HOSTS).map(h => `DNS:${h}`).join(',')}`, '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`], { stdio: 'ignore' });
    const video = webm(dir);
    const font = FONTS.find(f => existsSync(f));
    const assets = { wav: wav(10), video, fontBytes: font ? readFileSync(font) : Buffer.from('not a font'), realFont: Boolean(font) };
    const hits: Hit[] = [];
    const server = https.createServer({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, (req, res) => {
        const url = new URL(req.url ?? '/', 'https://x');
        const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
        if (url.pathname === '/host') {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<!doctype html><title>host</title><body>host page</body>');
            return;
        }
        const m = /^\/(cors|nocors|null|creds)\/([^/]+)$/.exec(url.pathname);
        const cookie = String(req.headers.cookie ?? '');
        const hit: Hit = {
            method: req.method ?? '', host, path: url.pathname, k: url.searchParams.get('k') ?? '',
            cookies: cookie ? cookie.split(/;\s*/).map(c => c.split('=')[0]!) : [], origin: String(req.headers.origin ?? '-'),
            mode: String(req.headers['sec-fetch-mode'] ?? '-'), dest: String(req.headers['sec-fetch-dest'] ?? '-'), site: String(req.headers['sec-fetch-site'] ?? '-'),
            range: String(req.headers.range ?? '-'), status: 0, referer: String(req.headers.referer ?? '-'),
        };
        hits.push(hit);
        if (!m) { hit.status = 404; res.writeHead(404); res.end(); return; }
        const acao = m[1] as Acao, file = m[2]!;
        const cors: Record<string, string> = acao === 'cors' ? { 'access-control-allow-origin': '*' }
            : acao === 'null' ? { 'access-control-allow-origin': 'null' }
                : acao === 'creds' ? { 'access-control-allow-origin': 'null', 'access-control-allow-credentials': 'true' } : {};
        const headers = { ...cors, 'cache-control': 'no-store' };
        if (req.method === 'OPTIONS') { hit.status = 204; res.writeHead(204, { ...headers, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET' }); res.end(); return; }
        const ranged = !url.searchParams.has('norange');
        const send = (type: string, body: Buffer | string, ranges = false) => {
            const bytes = typeof body === 'string' ? Buffer.from(body) : body;
            const r = ranges && ranged ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '')) : null;
            if (r) {
                const start = r[1] ? Number(r[1]) : 0, end = Math.min(r[2] ? Number(r[2]) : bytes.length - 1, bytes.length - 1);
                hit.status = 206;
                res.writeHead(206, { ...headers, 'content-type': type, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
                res.end(bytes.subarray(start, end + 1));
                return;
            }
            hit.status = 200;
            res.writeHead(200, { ...headers, 'content-type': type, 'content-length': bytes.length, ...(ranges && ranged ? { 'accept-ranges': 'bytes' } : {}) });
            res.end(bytes);
        };
        const k = hit.k;
        if (file === 'a.png') return send('image/png', PNG);
        if (file === 'e.wav') return send('audio/wav', assets.wav, true);
        if (file === 'v.webm') return assets.video ? send('video/webm', assets.video, true) : send('audio/wav', assets.wav, true);
        if (file === 'g.vtt') return send('text/vtt', VTT);
        if (file === 'f.ttf') return send('font/ttf', assets.fontBytes);
        if (file === 'imp.css') return send('text/css', '*{--imp:1}');
        if (file === 's.css') {
            // a stylesheet with its own subresources, relative to its URL: an import, a font, a background, an image-set
            return send('text/css', `@import url("imp.css?k=${k}.sub-import");
@font-face{font-family:"F-${k}";src:url("f.ttf?k=${k}.sub-font")}
[data-c="${k}"]{width:7px;height:7px;font-family:"F-${k}";background:url("a.png?k=${k}.sub-bg")}
[data-c="${k}"]::before{content:"";display:block;width:2px;height:2px;background-image:image-set(url("a.png?k=${k}.sub-set") 1x)}`);
        }
        if (file === 'r.png') { // a redirect to another URL (`to`), the answer carrying the same ACAO
            hit.status = 302;
            res.writeHead(302, { ...headers, location: url.searchParams.get('to') ?? '/' });
            res.end();
            return;
        }
        hit.status = 404; res.writeHead(404, headers); res.end();
    });
    server.on('upgrade', (_req, socket) => socket.destroy());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const origin = (t: Target) => `https://${HOSTS[t]}:${port}`;
    return {
        port, origin, hits, assets,
        stop: () => { server.closeAllConnections(); server.close(); },
    };
}

/**
 * The cookie jar. Domain cookies of the host's site (`.wsprobe.test`: H and S) and of X's site (`.wsprobe2.test`), and
 * host-only cookies of H, S and X; every SameSite value that can be sent cross-site or not. Secure everywhere (the
 * listener is HTTPS). A name says its kind: d_* domain cookie of the host's site, xd_* domain cookie of X's site, h_*, s_*
 * and x_* host-only cookies of H, S and X.
 */
export const COOKIES = [
    ...(['None', 'Lax', 'Strict'] as const).flatMap(site => [
        { name: `d_${site.toLowerCase()}`, domain: '.wsprobe.test', sameSite: site },
        { name: `xd_${site.toLowerCase()}`, domain: '.wsprobe2.test', sameSite: site },
    ]),
    ...(['None', 'Lax'] as const).flatMap(site => [
        { name: `h_${site.toLowerCase()}`, domain: HOSTS.H, sameSite: site },
        { name: `s_${site.toLowerCase()}`, domain: HOSTS.S, sameSite: site },
        { name: `x_${site.toLowerCase()}`, domain: HOSTS.X, sameSite: site },
    ]),
].map(c => ({ ...c, value: createHash('sha1').update(c.name).digest('hex').slice(0, 6), path: '/', secure: true }));
