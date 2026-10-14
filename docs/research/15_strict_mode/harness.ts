import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { walkChromiumFrames } from '../../../test/e2e/strict-view';

/**
 * Harness for the strict-mode probes (research 15). No library code: the frame topology of the
 * design (strict-design.md) is built directly.
 *
 *   host page (host.html, no CSP)
 *   └─ wrapper  srcdoc, sandbox="allow-scripts allow-forms", CSP frame-src 'none', base about:blank,
 *               referrer no-referrer — a copy of buildWrapperDocument (src/lib/frame-documents.ts)
 *      └─ view  srcdoc = CSP <meta> (hash-only script-src) + ONE bootstrap script, no guest bytes
 *         └─ worker  new Worker(blob:) spawned by the bootstrap on INIT_VIEW; source posted by the host
 *
 * Every document is built here in Node; host.html only inserts the outer frame and posts INIT_VIEW.
 */

// ---- documents ---------------------------------------------------------------------------------

export const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

/** CSP hash-source of a script text: SHA-256 over its UTF-8 bytes, standard base64. */
export const hashSource = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** The view policy of the design (default config), with the hashes of the scripts it admits. */
export function viewPolicy(hashes: string[], extra: { scriptSrc?: string; imgSrc?: string; connectSrc?: string; formAction?: string } = {}): string {
    return [
        "default-src 'none'",
        `script-src ${[...hashes, extra.scriptSrc ?? ''].join(' ').trim()}`,
        "script-src-attr 'none'",
        "style-src 'unsafe-inline'",
        "base-uri 'none'",
        `form-action ${extra.formAction ?? "'none'"}`,
        'worker-src blob:',
        "frame-src 'none'",
        "object-src 'none'",
        'upgrade-insecure-requests',
        ...(extra.imgSrc ? [`img-src ${extra.imgSrc}`] : []),
        ...(extra.connectSrc ? [`connect-src ${extra.connectSrc}`] : []),
    ].join('; ');
}

/** The view document: the CSP <meta> and the given scripts in <head>, nothing else. */
export function viewDocument(policy: string, scripts: string[], body = ''): string {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`;
    return `<!DOCTYPE html><html><head>${meta}${scripts.map(s => `<script>${s}</script>`).join('')}</head><body>${body}</body></html>`;
}

export const WRAPPER_CSP = "frame-src 'none'";

/** Copy of buildWrapperDocument (src/lib/frame-documents.ts @ bb5c5fb), without permissions. */
export function wrapperDocument(view: string, sandboxFlags: string): string {
    const style = '<style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style>';
    const frame = `<iframe sandbox="${escapeAttribute(sandboxFlags)}" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(view)}"></iframe>`;
    const head = `<meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}"><base href="about:blank"><meta name="referrer" content="no-referrer">${style}`;
    return `<!DOCTYPE html><html><head>${head}</head><body>${frame}</body></html>`;
}

// ---- the view bootstrap ------------------------------------------------------------------------

/**
 * The one script the view runs, admitted by its hash. It follows the design: accepts exactly one
 * INIT_VIEW from parent.parent (capture listener, stopImmediatePropagation), spawns the worker from a
 * blob, hands it the logic port and a fresh render port, applies VIEW_RENDER frames (template →
 * strip scripts → force sandbox="" → replaceChildren, at most once per animation frame per target)
 * and cancels link/submit defaults. Research toggles arrive in INIT_VIEW.opts, so the text — and the
 * hash — never change:
 *   stripScripts / forceSandbox / cancelNav (default true), clone (importNode instead of moving the
 *   template content), sync (apply on receipt, no animation-frame coalescing), ack (VIEW_ACK after
 *   each flush).
 * Marker: every run pushes 'bootstrap' to globalThis.__ran, so a copy that runs is counted.
 * It contains no "<" at all, so no script-data escape state can be entered.
 */
export const BOOTSTRAP = `(() => {
  const g = globalThis;
  (g.__ran = g.__ran || []).push('bootstrap');
  g.__violations = [];
  g.__events = [];
  g.__stats = { received: 0, applied: 0, flushes: 0 };
  let viewPort = null, renderPort = null, opts = {}, initialised = false;
  document.addEventListener('securitypolicyviolation', (e) => {
    const v = { directive: e.effectiveDirective || e.violatedDirective, blocked: String(e.blockedURI), sample: e.sample || '' };
    g.__violations.push(v);
    if (viewPort) viewPort.postMessage({ type: 'VIOLATION', v });
  }, true);
  const apply = (html, into) => {
    const t = document.createElement('template');
    t.innerHTML = html;
    let frag = t.content;
    if (opts.stripScripts !== false) frag.querySelectorAll('script').forEach((s) => s.remove());
    if (opts.forceSandbox !== false) frag.querySelectorAll('iframe').forEach((f) => f.setAttribute('sandbox', ''));
    if (opts.clone) frag = document.importNode(frag, true);
    const target = into ? document.getElementById(into) : document.body;
    if (target) target.replaceChildren(frag);
    g.__stats.applied++;
  };
  const pending = new Map();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    g.__stats.flushes++;
    const jobs = Array.from(pending);
    pending.clear();
    jobs.forEach(([into, html]) => apply(html, into));
    if (opts.ack && renderPort) renderPort.postMessage({ type: 'VIEW_ACK' });
  };
  const onRender = (e) => {
    const d = e.data;
    if (!d || d.type !== 'VIEW_RENDER' || typeof d.html !== 'string' || d.html.length > 1048576) return;
    if (d.into !== null && typeof d.into !== 'string') return;
    g.__stats.received++;
    if (opts.sync) { apply(d.html, d.into); if (opts.ack) renderPort.postMessage({ type: 'VIEW_ACK' }); return; }
    pending.set(d.into, d.html);
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  };
  ['click', 'submit', 'input', 'change', 'keydown'].forEach((type) => document.addEventListener(type, (e) => {
    const t = e.target;
    g.__events.push({ type, trusted: e.isTrusted, id: t && t.id ? t.id : '' });
    if (opts.cancelNav !== false) {
      if (type === 'submit') e.preventDefault();
      if (type === 'click' && t && t.closest) {
        const a = t.closest('a[href], area[href]');
        if (a && (a.getAttribute('href') || '').charAt(0) !== '#') e.preventDefault();
      }
    }
    if (renderPort) renderPort.postMessage({ type: 'VIEW_EVENT', detail: { type, id: t && t.id ? t.id : '' } });
  }, true));
  addEventListener('message', (event) => {
    if (initialised || event.source !== parent.parent || !event.data || event.data.type !== 'INIT_VIEW') return;
    event.stopImmediatePropagation();
    initialised = true;
    opts = event.data.opts || {};
    const logicPort = event.ports[0];
    viewPort = event.ports[1];
    const channel = new MessageChannel();
    renderPort = channel.port1;
    renderPort.onmessage = onRender;
    let worker;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([event.data.workerSource], { type: 'text/javascript' })));
    } catch (err) {
      viewPort.postMessage({ type: 'GUEST_ERROR', message: String(err) });
      return;
    }
    worker.onerror = (e) => viewPort.postMessage({ type: 'GUEST_ERROR', message: String(e.message) });
    worker.postMessage({ type: 'INIT_WORKER' }, [logicPort, channel.port2]);
    viewPort.postMessage({ type: 'VIEW_READY' });
  }, true);
})();`;

/**
 * Worker prelude: the probe body defines `async function main()`; results go to the host over the
 * logic port (RESULT, then DONE). PING → PONG for the host's round trips. `render(html, into)` posts a
 * VIEW_RENDER on the render port; `onRender(fn)` receives what the view sends back.
 */
export const WORKER_PRELUDE = `
let logic = null, render = null, renderListener = null;
const results = {};
const report = (k, v) => { results[k] = v; };
const post = (html, into = null) => render.postMessage({ type: 'VIEW_RENDER', html, into });
const onRender = (fn) => { renderListener = fn; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errorName = (e) => (e && e.name) || String(e);
self.addEventListener('securitypolicyviolation', (e) => {
  if (logic) logic.postMessage({ type: 'VIOLATION', v: { directive: e.effectiveDirective || e.violatedDirective, blocked: String(e.blockedURI) } });
});
self.onmessage = (e) => {
  if (!e.data || e.data.type !== 'INIT_WORKER' || logic) return;
  logic = e.ports[0];
  render = e.ports[1];
  logic.onmessage = (m) => { if (m.data && m.data.type === 'PING') logic.postMessage({ type: 'PONG', n: m.data.n }); };
  render.onmessage = (m) => { if (renderListener) renderListener(m.data); };
  Promise.resolve().then(() => main()).catch((err) => report('mainError', String(err)))
    .then(() => logic.postMessage({ type: 'DONE', results }));
};
`;

export const workerSource = (body: string) => `${WORKER_PRELUDE}\n${body}`;

// ---- mounting ----------------------------------------------------------------------------------

export const FLAGS = 'allow-scripts allow-forms';

export interface MountOptions {
    policy?: string; // default: viewPolicy([hash(BOOTSTRAP)])
    scripts?: string[]; // default: [BOOTSTRAP]
    body?: string;
    wrapped?: boolean; // default true: host → wrapper → view; false: host → view (positive controls)
    sandbox?: string; // flags of both frames, default FLAGS
}

let mounts = 0;

/** Mounts the topology on host.html and returns the view document it used. */
export async function mount(page: Page, options: MountOptions = {}) {
    const scripts = options.scripts ?? [BOOTSTRAP];
    const policy = options.policy ?? viewPolicy(scripts.map(hashSource));
    const view = viewDocument(policy, scripts, options.body ?? '');
    const wrapped = options.wrapped ?? true;
    const sandbox = options.sandbox ?? FLAGS;
    // a fresh document per mount: the query changes, so this is never a same-document (fragment) navigation
    await page.goto(`/host.html?secret=HOST-SECRET-PATH&mount=${++mounts}#frag`);
    await page.evaluate(o => (window as any).mount(o), { srcdoc: wrapped ? wrapperDocument(view, sandbox) : view, sandbox });
    return { view, wrapped };
}

/** Posts INIT_VIEW with the worker body; waits for VIEW_READY. */
export async function init(page: Page, wrapped: boolean, body: string, opts: Record<string, unknown> = {}) {
    await page.evaluate(([w, s, o]) => (window as any).init(w, s, o), [wrapped, workerSource(body), opts] as const);
    await page.waitForFunction(() => (window as any).inbox.some((m: any) => m.data?.type === 'VIEW_READY' || m.data?.type === 'GUEST_ERROR'), null, { timeout: 10000 });
}

/** Waits for the worker's DONE and returns its results. */
export async function workerResults(page: Page, timeout = 20000): Promise<Record<string, any>> {
    await page.waitForFunction(() => (window as any).inbox.some((m: any) => m.data?.type === 'DONE'), null, { timeout });
    return page.evaluate(() => (window as any).inbox.find((m: any) => m.data?.type === 'DONE').data.results);
}

export const inbox = (page: Page): Promise<{ port: string; data: any }[]> => page.evaluate(() => (window as any).inbox);

// ---- reading markers from every frame ----------------------------------------------------------

/**
 * One frame below (or at) the host page, as Playwright or CDP sees it.
 * path: from the top, e.g. "main/outer/d2/c1" (outer = the frame host.html inserts — the wrapper, or
 * the view when unwrapped; d2 = the view under the wrapper; rendered frames by their name attribute).
 * value: the evaluated expression, or 'no-context' when the frame exposes no script context (a frame
 * whose scripts are disabled, sandbox="", in Chromium).
 */
export interface FrameValue<T = unknown> { path: string; url: string; value: T | 'no-context' }

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T) =>
    Promise.race([promise.catch(() => fallback), new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

function framePath(frame: Frame): string {
    const chain: Frame[] = [];
    for (let f: Frame | null = frame; f; f = f.parentFrame()) chain.unshift(f);
    return chain.map((f, depth) => (depth === 0 ? 'main' : f.name() || `d${depth}`)).join('/');
}


/**
 * Evaluates `expression` (a JS expression string, JSON-serialisable result) in every frame.
 *
 * Firefox and WebKit: through page.frames(). Chromium: the sandboxed wrapper is an out-of-process
 * iframe, and Playwright 1.58 with the Chromium 141 used here lists it with no child frames (measured:
 * page.frames() = [host, outer] while CDP Page.getFrameTree on the OOPIF session lists view and
 * rendered frames). So below the host page Chromium is read through a CDP session on that target:
 * its frame tree, and Runtime.evaluate in each frame's default execution context. DevTools
 * evaluation is not subject to the page's CSP in any engine.
 */
export async function inFrames<T = unknown>(page: Page, expression: string, browserName: string): Promise<FrameValue<T>[]> {
    const results: FrameValue<T>[] = [];
    if (browserName !== 'chromium') {
        for (const frame of page.frames()) {
            const value = await withTimeout<T | 'no-context'>(frame.evaluate(expression) as Promise<T>, 2000, 'no-context');
            results.push({ path: framePath(frame), url: frame.url(), value });
        }
        return results;
    }
    // CDP only, through the page's own session (test/e2e/strict-view.ts): independent of whether Chromium runs the
    // wrapper out of process, which varies by environment (in-process on CI runners), and of Playwright linking it.
    // Paths keep this harness's scheme: main, then each frame's name or d<depth> (main/outer/d2 is the view).
    await walkChromiumFrames(page, async (cdp, frame, path, contextId) => {
        let value: T | 'no-context' = 'no-context';
        if (contextId !== undefined) {
            const reply = await withTimeout(cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }) as Promise<any>, 2000, null);
            if (reply && !reply.exceptionDetails) value = reply.result.value as T;
        }
        results.push({ path, url: frame.url + (frame.urlFragment ?? ''), value });
    }, (depth, name) => (depth === 0 ? 'main' : name || `d${depth}`));
    return results;
}

/** Every frame's script-run markers (globalThis.__ran). */
export const frameStates = (page: Page, browserName: string) =>
    inFrames<string[]>(page, '(globalThis.__ran || [])', browserName);

/** All markers seen anywhere on the page, as "path:marker". */
export async function markers(page: Page, browserName: string): Promise<string[]> {
    return (await frameStates(page, browserName)).flatMap(s => (s.value === 'no-context' ? [] : s.value.map(m => `${s.path}:${m}`)));
}

/** One value from the view (path main/outer/d2, or main/outer when unwrapped). */
export async function inView<T = unknown>(page: Page, expression: string, browserName: string, wrapped = true): Promise<T | 'no-context'> {
    const target = wrapped ? 'main/outer/d2' : 'main/outer';
    const found = (await inFrames<T>(page, expression, browserName)).find(f => f.path === target);
    return found ? found.value : 'no-context';
}

/**
 * The effective script policy of each frame, tested from outside: an inline <script> inserted through
 * the DOM (the evaluation itself bypasses the CSP; the script element it inserts does not).
 * 'ran' | 'blocked' | 'no-context'. 'blocked' also covers a frame whose scripts are disabled.
 */
export const INLINE_SCRIPT_POLICY = `(() => {
    globalThis.__policyProbe = false;
    const s = document.createElement('script');
    s.textContent = 'globalThis.__policyProbe = true';
    (document.head || document.documentElement).appendChild(s);
    return globalThis.__policyProbe ? 'ran' : 'blocked';
})()`;

/** A trusted click at a point of the outer frame (the view fills the wrapper from its top-left). */
export async function clickInView(page: Page, x: number, y: number) {
    const box = await page.locator('#outer').boundingBox();
    await page.mouse.click(box!.x + x, box!.y + y);
}

// ---- evidence outside the browser --------------------------------------------------------------

export type Hit = { path: string; method: string; referer: string | null };

/**
 * An HTTPS listener on loopback recording every request (path, method, Referer). Reachable as
 * `origin` (https://127.0.0.1:<port>, cross-site to the host page) and as `localOrigin`
 * (https://localhost:<port>, the host page's own host name: same-site except for the scheme).
 */
export class Listener {
    readonly hits: Hit[] = [];
    origin = '';
    localOrigin = '';
    private servers: https.Server[] = [];
    private certDir = '';

    async start() {
        this.certDir = mkdtempSync(path.join(tmpdir(), 'strict-probe-cert-'));
        const key = path.join(this.certDir, 'key.pem');
        const cert = path.join(this.certDir, 'cert.pem');
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
            '-addext', 'subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
        const tls = { key: readFileSync(key), cert: readFileSync(cert) };
        const handler = (req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url ?? '/', 'https://listener');
            this.hits.push({ path: url.pathname + url.search, method: req.method ?? '', referer: req.headers.referer ?? null });
            const ext = path.extname(url.pathname);
            const type = ext === '.svg' ? 'image/svg+xml' : ext === '.js' ? 'text/javascript' : 'text/html';
            const body = ext === '.svg' ? '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="5"></svg>'
                : ext === '.js' ? 'globalThis.__listenerScriptRan = true;' : '<!DOCTYPE html><p>listener</p>';
            res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' });
            res.end(body);
        };
        // the same port on 127.0.0.1 and ::1, so "localhost" reaches it whichever address the browser tries
        const v4 = https.createServer(tls, handler);
        await new Promise<void>(resolve => v4.listen(0, '127.0.0.1', resolve));
        const port = (v4.address() as AddressInfo).port;
        this.servers.push(v4);
        const v6 = https.createServer(tls, handler);
        await new Promise<void>(resolve => { v6.once('error', () => resolve()); v6.listen(port, '::1', resolve); });
        if (v6.listening) this.servers.push(v6);
        this.origin = `https://127.0.0.1:${port}`;
        this.localOrigin = `https://localhost:${port}`;
    }

    async stop() {
        await Promise.all(this.servers.map(server => {
            const closed = new Promise(resolve => server.close(resolve));
            server.closeAllConnections();
            return closed;
        }));
        if (this.certDir) rmSync(this.certDir, { recursive: true, force: true });
    }

    clear() { this.hits.length = 0; }
    paths(prefix = '/'): string[] { return this.hits.map(h => h.path).filter(p => p.startsWith(prefix)); }
}

/** A loopback UDP listener (STUN/TURN target of the ICE probes). */
export class UdpListener {
    packets = 0;
    port = 0;
    private socket: dgram.Socket | null = null;

    async start() {
        this.socket = dgram.createSocket('udp4');
        this.socket.on('message', () => this.packets++);
        await new Promise<void>(resolve => this.socket!.bind(0, '127.0.0.1', resolve));
        this.port = (this.socket.address() as AddressInfo).port;
    }

    stop() { this.socket?.close(); }
}

/** ICE gathering against a STUN and a TURN server on 127.0.0.1:<port>; calls done(result) after 3 s. */
export const iceProbe = (port: number) => `(done) => {
    const r = { pc: typeof RTCPeerConnection, candidates: [] };
    if (typeof RTCPeerConnection !== 'function') { done(r); return; }
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }, { urls: 'turn:127.0.0.1:${port}?transport=udp', username: 'u', credential: 'c' }] });
    pc.createDataChannel('x');
    pc.onicecandidate = (e) => { if (e.candidate) r.candidates.push(e.candidate.type); };
    pc.createOffer().then(o => pc.setLocalDescription(o));
    setTimeout(() => { pc.close(); done(r); }, 3000);
}`;
