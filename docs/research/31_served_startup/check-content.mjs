// Q8's two views of the policy check (I18).
//
// - `fixedScript()`: the fixture's C (cScript, Q1's order) with three timestamps added to its check, and nothing else
//   changed: when the canaries were issued (t0), when the last of them settled, and when the twin canary was issued. Its
//   windows: the canaries' (issue to settled), the 30 ms wait, the twin's (issue to the end of its 30 ms), and after.
// - `contentScript()`: a check with no fixed wait and no window. Every expected canary is a load the <meta> refuses,
//   identified from its event alone by its own URL (canaries.mjs: one host per kind and scheme). It decides when each
//   expected canary has raised at least one <meta> event and every admitted load has settled, or at one overall
//   timeout: clean when no event carried another policy text or disposition, the duplicate-test canaries raised exactly
//   one event each, and every admitted load did what the <meta> makes it do. It answers on the port as Q1's C does
//   (hash, verdicts), then keeps listening for `late` ms and posts every event with its time, for Q8's analysis.
import { cScript, metaPolicy } from './fixture.mjs';
import { canaryUrl, kinds } from './canaries.mjs';

const HOLE = '__C_HASH__';

/** The fixture's C with the check's window boundaries recorded (T.t0, T.allSettled, T.twinFrom); `wait` replaces its two 30 ms waits. */
export function fixedScript({ wait = 30 } = {}) {
    const s = cScript();
    const out = s
        .replaceAll('setTimeout(r, 30))', `setTimeout(r, ${wait}))`)
        .replaceAll('await Promise.all(pend);', 'await Promise.all(pend); T.allSettled = Math.round(performance.now() - t0); T.t0 = t0;')
        .replaceAll('const before = ev.length;', 'const before = ev.length; T.twinFrom = Math.round(performance.now() - t0);');
    if (out === s || (out.match(/T\.twinFrom/g) || []).length !== 2) throw new Error('fixedScript: the check text changed');
    return out;
}

const SCHEMES = ['http', 'https'];
/** The content check's canaries: refused loads (expected, by URL), and admitted ones read by their outcome. */
const C_REFUSED = ['img', 'style', 'fetch', 'script', 'font-api', 'audio', 'frame', 'object'];
const W_REFUSED = ['w-fetch', 'w-import-scripts', 'w-import'];
const C_LOCAL = ['worker-data', 'img-blob', 'style-blob', 'worker-blob', 'fetch-blob', 'eval'];
const W_LOCAL = ['w-fetch-blob', 'w-eval'];
/** What an admitted or local canary must do under the <meta> alone. */
export const WANT = { 'img-blob': 'loaded', 'style-blob': 'load', 'worker-blob': 'ran', 'fetch-blob': 'refused TypeError', eval: 'refused', 'w-fetch-blob': 'refused TypeError', 'w-eval': 'refused' };
/** The duplicate test's canaries: one <meta> event per load on all three engines (Q6's baseline). */
export const DUP = ['fetch http', 'w-fetch http'];
export const EXPECTED = [...C_REFUSED, ...W_REFUSED].flatMap((k) => SCHEMES.map((s) => `${k} ${s}`)).concat(['worker-src data']);

const jobs = (refused, local) => [...refused.flatMap((k) => SCHEMES.map((s) => [k, canaryUrl(k, s)])), ...local.map((k) => [k])];

function wMain8() {
    const EP = () => performance.timeOrigin + performance.now();
    self.addEventListener('securitypolicyviolation', (e) => postMessage({ ev: { realm: 'W', dir: e.effectiveDirective, disp: e.disposition, blocked: String(e.blockedURI).slice(0, 80), policy: e.originalPolicy, ep: EP() } }));
    const K = (__KINDS__)();
    self.onmessage = (m) => {
        for (const [key, url] of m.data.jobs) Promise.resolve().then(() => K[key](url, (x) => x)).then((v) => postMessage({ out: { [key]: v } }), (x) => postMessage({ out: { [key]: 'throws ' + (x && x.name) } }));
    };
    postMessage('up');
}

function cMain8(CFG) {
    const EP = () => performance.timeOrigin + performance.now();
    const SELF = document.currentScript.textContent;
    const ev = [];
    let onEvent = null;
    const push = (r) => { ev.push(r); if (onEvent) onEvent(r); };
    document.addEventListener('securitypolicyviolation', (e) => push({ realm: 'C', dir: e.effectiveDirective, disp: e.disposition, blocked: String(e.blockedURI).slice(0, 80), policy: e.originalPolicy, ep: EP() }));
    const K = (__KINDS__)();
    // Q8's second form: the admitted blob: worker's outcome waits for the worker's message or error, with no 600 ms cut
    // (the overall timeout bounds it)
    if (CFG.workerNoCut) K['worker-blob'] = () => new Promise((r) => { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))); w.onmessage = () => r('ran'); w.onerror = () => r('error event'); });
    const norm = (p) => String(p).split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean).sort().join('; ');
    // what identifies a canary from its event: its own host (one per kind) and scheme; else the directive and the scheme
    const idOf = (r) => { const m = /^(https?):\/\/([a-z-]+)\.canary\.invalid/.exec(r.blocked); return m ? m[2] + ' ' + m[1] : r.dir + ' ' + (r.blocked.split(':')[0] || '(empty)'); };
    let taken = false;
    addEventListener('message', async (e) => {
        if (taken || e.source !== parent.parent || !e.ports[0] || e.data !== 'ws-hello') return;
        taken = true;
        const port = e.ports[0];
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SELF)));
        const hash = "'sha256-" + btoa(String.fromCharCode(...digest)) + "'";
        const mine = norm(CFG.template.replace(CFG.hole, hash));
        const isMeta = (r) => norm(r.policy) === mine && r.disp === 'enforce';
        const t0 = EP();
        const seen = new Map();
        const foreign = [];
        const outcomes = {};
        let wStarted = null;
        let verdict = null;
        let finish;
        const done = new Promise((r) => { finish = r; });
        const tracked = [];
        const decide = (why) => {
            if (verdict) return;
            const missing = CFG.expected.filter((id) => !(seen.get(id) || []).some(isMeta));
            const off = Object.entries(CFG.want).filter(([k, v]) => k in outcomes && outcomes[k] !== v).map(([k]) => k + ': ' + outcomes[k]);
            const unsettled = Object.keys(CFG.want).filter((k) => !(k in outcomes));
            const dup = CFG.dup.filter((id) => (seen.get(id) || []).length !== 1).map((id) => id + ' x' + (seen.get(id) || []).length);
            verdict = { clean: why === 'expected in' && !foreign.length && !off.length && !dup.length && wStarted === 'yes', why, foreign: foreign.length, off, dup, missing, unsettled, worker: wStarted, ms: +(EP() - t0).toFixed(1) };
            finish();
        };
        const ready = () => {
            if (verdict || wStarted === null) return;
            if (wStarted !== 'yes') { decide('worker ' + wStarted); return; }
            if (CFG.expected.some((id) => !(seen.get(id) || []).some(isMeta))) return;
            if (Object.keys(CFG.want).some((k) => !(k in outcomes))) return;
            decide('expected in');
        };
        onEvent = (r) => {
            r.id = idOf(r); r.dt = +(r.ep - t0).toFixed(1); r.meta = isMeta(r); r.afterVerdict = !!verdict;
            if (!seen.has(r.id)) seen.set(r.id, []);
            seen.get(r.id).push(r);
            if (!r.meta) foreign.push(r);
            ready();
        };
        let w;
        try { w = new Worker(URL.createObjectURL(new Blob([CFG.wsrc], { type: 'text/javascript' }))); } catch (x) { wStarted = 'throws ' + x.name; }
        if (w) {
            w.onerror = () => { wStarted = 'error event'; ready(); };
            w.onmessage = (m) => {
                if (m.data === 'up') { wStarted = 'yes'; w.postMessage({ jobs: CFG.wjobs }); ready(); return; }
                if (m.data.ev) push(m.data.ev);
                if (m.data.out) { Object.assign(outcomes, m.data.out); ready(); }
            };
        }
        for (const [key, url] of CFG.cjobs) Promise.resolve().then(() => K[key](url, (x) => { tracked.push(x); return x; })).then((v) => { if (key in CFG.want) { outcomes[key] = v; ready(); } }, (x) => { if (key in CFG.want) { outcomes[key] = 'throws ' + (x && x.name); ready(); } });
        setTimeout(() => decide('timeout'), CFG.timeout);
        await done;
        port.postMessage({ version: '1', hash, C: { gates: {}, check: verdict }, W: { started: wStarted === 'yes' ? 'yes' : String(wStarted), gates: {}, check: { clean: true } } });
        await new Promise((r) => setTimeout(r, CFG.late));
        const meta = (id) => (seen.get(id) || []).filter(isMeta).length;
        port.postMessage({ late: { verdictMs: verdict.ms, events: ev.map((r) => ({ id: r.id, realm: r.realm, dir: r.dir, disp: r.disp, meta: r.meta, policy: r.meta ? 'META' : String(r.policy).slice(0, 80), dt: r.dt, afterVerdict: r.afterVerdict })), dupFinal: CFG.dup.map((id) => id + ' x' + (seen.get(id) || []).length), lateForeign: foreign.filter((r) => r.afterVerdict).length, metaCounts: Object.fromEntries([...seen.keys()].map((id) => [id, meta(id)])) } });
        for (const x of tracked) x.remove();
        if (w) w.terminate();
    });
}

const fill = (f) => `(${f.toString()})`.replace('__KINDS__', kinds.toString());

/** The content check's C bootstrap. */
export function contentScript({ timeout = 3000, late = 300, workerNoCut = false } = {}) {
    const cfg = { workerNoCut, template: metaPolicy(HOLE), hole: HOLE, expected: EXPECTED, want: WANT, dup: DUP, cjobs: jobs(C_REFUSED, C_LOCAL), wjobs: jobs(W_REFUSED, W_LOCAL), wsrc: `${fill(wMain8)}();`, timeout, late };
    return `${fill(cMain8)}(${JSON.stringify(cfg)});`;
}
