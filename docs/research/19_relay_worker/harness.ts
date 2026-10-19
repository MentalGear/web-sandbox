import { buildWrapperDocument } from '../../../src/lib/frame-documents';
import { buildViewDocument } from '../../../src/lib/in-sandbox-view';
import { strictViewPolicy } from '../../../src/lib/csp/csp-generator';
import { parseOrigins, type OriginKind } from '../../../src/lib/csp/origins';
import { scriptHashSource } from '../../../src/lib/csp/script-hash';
import { createSizeOf } from '../../../src/lib/structured-size';

/**
 * Harness for the relay-worker probes (research 19). No library runtime code: the strict topology is built directly,
 * with the library's own document builders and policy generator (pure functions, read only), so the view runs under
 * exactly the policy and sandbox flags strict mode gives it at 7b13007.
 *
 *   host page (host.html; optional Cross-Origin-Embedder-Policy)
 *   └─ wrapper  buildWrapperDocument(view, 'allow-scripts allow-forms')          (src/lib/frame-documents.ts)
 *      └─ view  buildViewDocument(strictViewPolicy(...), BOOTSTRAP)              (src/lib/in-sandbox-view.ts)
 *         ├─ layout 'direct' (today):  view ─ new Worker(blob:) ─ guest
 *         └─ layout 'relay' (proposed): view ─ new Worker(blob:) ─ relay ─ new Worker(blob: minted by the relay) ─ guest
 *
 * Ports, per environment, created by the host page:
 *   logic  host ↔ guest (direct), or host ↔ relay ↔ guest (relay: the relay holds it and forwards measured frames)
 *   view   host ↔ view   VIEW_READY, the view's and the relay's reports, commands to the view (TERMINATE, STATS, …)
 *   beat   host ← guest  the probe's own instrument: heartbeats that show whether the guest still runs after a
 *                        termination. It is not part of the design; nothing else uses it.
 *
 * The probe's toggles travel in INIT_VIEW.opts, so the bootstrap's text and its hash never change.
 */

export const FLAGS = 'allow-scripts allow-forms'; // STRICT_VIEW_FLAGS (src/host.ts)
export const CANARY_PORT = Number(process.env.RELAY_PROBE_CANARY_PORT || 5051);

// ---- the view's bootstrap --------------------------------------------------------------------------------------------

/**
 * The view's one script, admitted by its hash. Accepts one INIT_VIEW from parent.parent, spawns one worker from a blob:
 * URL it mints (the guest in 'direct', the relay in 'relay'), and passes the logic and beat ports on. Counts what reaches
 * it from the worker: error events (cancelled when opts.viewCancels, as the library's view does after the entry) and
 * messages (the guest's own postMessage in 'direct'; RELAY_OUT frames in 'relay', which it forwards to the host). No "<".
 */
export const BOOTSTRAP = `(() => {
  const g = globalThis;
  let started = false;
  addEventListener('message', (event) => {
    if (started || event.source !== parent.parent || !event.data || event.data.type !== 'INIT_VIEW') return;
    event.stopImmediatePropagation();
    started = true;
    const data = event.data;
    const opts = data.opts || {};
    const logicPort = event.ports[0];
    const viewPort = event.ports[1];
    const beatPort = event.ports[2];
    const stats = { errors: 0, errorChars: 0, firstError: null, messages: 0, forwarded: 0 };
    g.__stats = stats;
    let url = '';
    let worker = null;
    const spawnedAt = performance.now();
    try {
      url = URL.createObjectURL(new Blob([data.workerSource], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (error) {
      viewPort.postMessage({ type: 'SPAWN_FAILED', where: 'view', name: String(error && error.name), message: String(error && error.message) });
      return;
    }
    worker.onerror = (e) => {
      stats.errors++;
      const message = String(e.message);
      stats.errorChars += message.length;
      if (stats.firstError === null) stats.firstError = { message: message.slice(0, 120), length: message.length, filename: String(e.filename).slice(0, 60), hasError: e.error !== null && e.error !== undefined, at: Math.round(performance.now() - spawnedAt) };
      if (opts.viewCancels) e.preventDefault();
      if (stats.errors === 1) viewPort.postMessage({ type: 'VIEW_SAW_ERROR', first: stats.firstError });
    };
    worker.onmessage = (e) => {
      stats.messages++;
      const d = e.data;
      if (d && d.type === 'RELAY_OUT') { stats.forwarded++; viewPort.postMessage(d.frame); }
    };
    viewPort.onmessage = (m) => {
      const d = m.data || {};
      if (d.type === 'TERMINATE') { worker.terminate(); viewPort.postMessage({ type: 'TERMINATED', at: performance.now() }); }
      else if (d.type === 'REVOKE') { URL.revokeObjectURL(url); viewPort.postMessage({ type: 'REVOKED' }); }
      else if (d.type === 'STATS') viewPort.postMessage({ type: 'VIEW_STATS', stats });
      else if (d.type === 'TO_WORKER') worker.postMessage(d.data);
    };
    const init = { type: opts.layout === 'relay' ? 'INIT_RELAY' : 'INIT_GUEST', opts, guestSource: data.guestSource };
    worker.postMessage(init, [logicPort, beatPort]);
    if (opts.revokeView === 'spawn') URL.revokeObjectURL(url);
    viewPort.postMessage({ type: 'VIEW_READY' });
  }, true);
})();`;

// ---- the relay ---------------------------------------------------------------------------------------------------------

/**
 * The relay worker (proposed design). Mints the guest's blob: URL, spawns it, keeps its Worker object and the logic port.
 * Guest → relay: { type: 'LOGIC', frame } is measured with the library's own measure (structured-size.ts) after
 * deserialization and forwarded to the host when under 1 MiB; anything else is the guest's own traffic, handled per
 * opts.onGuestMessage:
 *   'bounded'  measured, then at most 100 notices a second of a few bytes each to the view (the design);
 *   'nothing'  a listener that does nothing;
 *   'none'     no message listener at all;
 *   'all'      forwarded whole to the view (a control: the old cost, one hop later).
 * Errors of the guest's Worker object are counted, cancelled when opts.relayCancels, and reported to the view at most
 * 10 a second, cut to 200 characters. With opts.relayTicks the relay counts its own 10 ms ticks (its own busy share).
 */
export const RELAY_SOURCE = `
const sizeOf = (${createSizeOf.toString()})();
const stats = { messages: 0, measuredBytes: 0, measureMs: 0, logicFrames: 0, errors: 0, errorChars: 0, firstError: null, notices: 0, ticks: 0, tickStart: 0 };
let guest = null, logic = null, opts = {}, url = '';
let noticeWindow = 0, noticeCount = 0, errorWindow = 0, errorCount = 0;
const toView = (frame, transfer) => postMessage({ type: 'RELAY_OUT', frame }, transfer || []);
const allow = (now, kind) => {
  if (kind === 'notice') { if (now - noticeWindow >= 1000) { noticeWindow = now; noticeCount = 0; } return ++noticeCount <= 100; }
  if (now - errorWindow >= 1000) { errorWindow = now; errorCount = 0; }
  return ++errorCount <= 10;
};
const fromGuest = (e) => {
  const d = e.data;
  stats.messages++;
  if (d && d.type === 'LOGIC') {
    const t0 = performance.now();
    const size = sizeOf(d.frame, 1048576);
    stats.measureMs += performance.now() - t0;
    if (size !== Infinity) { stats.logicFrames++; logic.postMessage(d.frame); }
    return;
  }
  if (opts.onGuestMessage === 'nothing') return;
  if (opts.onGuestMessage === 'all') { toView({ type: 'GUEST_DATA', data: d }); return; }
  const t0 = performance.now();
  const size = sizeOf(d, 1048576);
  stats.measureMs += performance.now() - t0;
  stats.measuredBytes += size === Infinity ? 1048576 : size;
  if (allow(performance.now(), 'notice')) { stats.notices++; toView({ type: 'GUEST_NOTICE', bytes: size === Infinity ? -1 : size }); }
};
self.onmessage = (e) => {
  const d = e.data || {};
  if (d.type === 'INIT_RELAY' && guest === null) {
    opts = d.opts || {};
    logic = e.ports[0];
    const beat = e.ports[1];
    if (opts.relayTicks) { stats.tickStart = performance.now(); setInterval(() => { stats.ticks++; }, 10); }
    try {
      url = URL.createObjectURL(new Blob([d.guestSource], { type: 'text/javascript' }));
      guest = new Worker(url);
    } catch (error) {
      toView({ type: 'SPAWN_FAILED', where: 'relay', name: String(error && error.name), message: String(error && error.message) });
      return;
    }
    guest.onerror = (ev) => {
      stats.errors++;
      const message = String(ev.message);
      stats.errorChars += message.length;
      if (stats.firstError === null) stats.firstError = { message: message.slice(0, 120), length: message.length, filename: String(ev.filename).slice(0, 60), hasError: ev.error !== null && ev.error !== undefined };
      if (opts.relayCancels) ev.preventDefault();
      if (allow(performance.now(), 'error')) toView({ type: 'RELAY_GUEST_ERROR', message: message.slice(0, 200), length: message.length });
    };
    if (opts.onGuestMessage !== 'none') guest.onmessage = fromGuest;
    else guest.addEventListener('message', (ev) => { const f = ev.data; if (f && f.type === 'LOGIC') logic.postMessage(f.frame); });
    logic.onmessage = (m) => { if (sizeOf(m.data, 1048576) !== Infinity) guest.postMessage(m.data); };
    guest.postMessage({ type: 'INIT_GUEST', opts }, [beat]);
    if (opts.revokeRelay === 'spawn') URL.revokeObjectURL(url);
    return;
  }
  if (d.type === 'STATS') { toView({ type: 'RELAY_STATS', stats, now: performance.now() }); return; }
  if (d.type === 'REVOKE') { URL.revokeObjectURL(url); toView({ type: 'REVOKED' }); return; }
  if (d.type === 'TERMINATE_GUEST') { guest.terminate(); toView({ type: 'GUEST_TERMINATED' }); return; }
};
`;

// ---- the guest -----------------------------------------------------------------------------------------------------------

/**
 * The guest's prelude and scenarios. Sends through `send`: the logic port in 'direct', its own postMessage to the
 * relay (wrapped as LOGIC) in 'relay'. With opts.guestCancels it cancels its own errors and rejections, as the library's
 * prelude does (errors since round 4, rejections from S64). Commands from the host: PING, RPC, START (a scenario), BUSY.
 */
export const GUEST_SOURCE = `
let layout = 'direct', opts = {}, logic = null, beat = null;
const send = (frame) => { if (layout === 'relay') postMessage({ type: 'LOGIC', frame }); else logic.postMessage(frame); };
const big = () => 'x'.repeat(2 ** 24);
const flood = (tick) => { const timer = setInterval(tick, 0); setTimeout(() => clearInterval(timer), opts.floodMs || 4600); };
const SCENARIOS = {
  idle() {},
  // each flood stops after opts.floodMs (default 4.6 s: the 500 ms lead and the 4 s window), so a run stays bounded
  rejections() { const text = big(); flood(() => { Promise.reject(new Error(text)); Promise.reject(new Error(text)); }); },
  rejectionsSmall() { flood(() => { Promise.reject(new Error('x')); Promise.reject(new Error('x')); }); },
  rejectionsString() { const text = big(); flood(() => { Promise.reject(text); Promise.reject(text); }); },
  errors() { const text = big(); flood(() => { reportError(new Error(text)); reportError(new Error(text)); }); },
  posts() { const p = new Uint8Array(8 * 1048576); flood(() => { for (let i = 0; i < 4; i++) postMessage(p); }); },
  heartbeat() { let n = 0; setInterval(() => beat.postMessage(n++), 20); },
  busy() { let n = 0, last = 0; for (;;) { const now = performance.now(); if (now - last > 20) { last = now; beat.postMessage(n++); } } },
  lateThrow() { setTimeout(() => { throw new Error('late error from the guest'); }, 0); },
  policy() {
    const out = { href: String(location.href).slice(0, 12), origin: String(self.origin), hasWorker: typeof Worker };
    try { eval('1'); out.eval = 'ran'; } catch (e) { out.eval = e.name; }
    try { new Function('return 1'); out.Function = 'ran'; } catch (e) { out.Function = e.name; }
    try { importScripts(URL.createObjectURL(new Blob(['1'], { type: 'text/javascript' }))); out.importScripts = 'ran'; } catch (e) { out.importScripts = e.name; }
    try { fetch(URL.createObjectURL(new Blob(['x']))).then(() => { out.blobFetch = 'ok'; }, (e) => { out.blobFetch = e.name; }); } catch (e) { out.blobFetch = 'threw ' + e.name; }
    try { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))); out.thirdLevel = 'constructed'; w.terminate(); } catch (e) { out.thirdLevel = e.name; }
    const done = () => setTimeout(() => send({ type: 'POLICY', out }), 200);
    fetch(opts.canary).then(() => { out.fetch = 'ok'; done(); }, (e) => { out.fetch = e.name; done(); });
  },
};
self.addEventListener('error', (e) => {
  if (opts.reportGuestErrors) send({ type: 'GUEST_SAW_ERROR', message: String(e.message).slice(0, 120), hasError: e.error !== null && e.error !== undefined });
  if (opts.guestCancels) e.preventDefault();
});
self.addEventListener('unhandledrejection', (e) => { if (opts.guestCancels) e.preventDefault(); });
const handle = (d) => {
  if (!d) return;
  if (d.type === 'PING') send({ type: 'PONG', n: d.n });
  else if (d.type === 'RPC') send({ type: 'RPC_RES', id: d.id, result: d.args[0] + d.args[1] });
  else if (d.type === 'START') SCENARIOS[d.scenario]();
};
self.onmessage = (e) => {
  const d = e.data;
  if (d && (d.type === 'INIT_GUEST') && logic === null && beat === null) {
    opts = d.opts || {};
    layout = opts.layout === 'relay' ? 'relay' : 'direct';
    if (layout === 'direct') { logic = e.ports[0]; beat = e.ports[1]; logic.onmessage = (m) => handle(m.data); }
    else beat = e.ports[0];
    send({ type: 'GUEST_READY', href: String(location.href).slice(0, 12) });
    return;
  }
  if (layout === 'relay') handle(d);
};
`;

// ---- documents -----------------------------------------------------------------------------------------------------------

export const BOOTSTRAP_HASH = scriptHashSource(BOOTSTRAP); // throws if the bootstrap is not its own parsed form

/**
 * The strict view's policy as the element makes it: by default no origins, no files and no scriptUnsafe. The positive
 * controls add a connect origin, or blob: to connect-src (what a registered file fetched by the guest adds).
 */
export function viewPolicy(connect: string[] = [], connectBlob = false): string {
    const origins = parseOrigins(connect.length > 0 ? { connect } : {}, 'strict', () => {});
    const fileKinds = new Set<OriginKind>(connectBlob ? ['connect'] : []);
    return strictViewPolicy({ origins, fileKinds, scriptUnsafe: false, bootstrapHash: BOOTSTRAP_HASH });
}

/** The wrapper document holding the view, as the element builds it in strict mode. */
export function wrapperDocument(connect: string[] = [], connectBlob = false): string {
    return buildWrapperDocument(buildViewDocument(viewPolicy(connect, connectBlob), BOOTSTRAP), FLAGS);
}

export type Layout = 'direct' | 'relay';

export interface Opts {
    layout: Layout;
    guestCancels?: boolean;
    viewCancels?: boolean;
    relayCancels?: boolean;
    onGuestMessage?: 'bounded' | 'nothing' | 'none' | 'all';
    relayTicks?: boolean;
    reportGuestErrors?: boolean;
    revokeView?: 'spawn' | 'never';
    revokeRelay?: 'spawn' | 'never';
    canary?: string;
    floodMs?: number;
}

/** What host.html's init() posts: the source the view spawns, the guest's source, the toggles. */
export function payload(opts: Opts) {
    return {
        workerSource: opts.layout === 'relay' ? RELAY_SOURCE : GUEST_SOURCE,
        guestSource: GUEST_SOURCE,
        opts,
    };
}
