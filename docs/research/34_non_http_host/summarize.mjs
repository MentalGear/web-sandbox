// Prints the compact view of research 34's raw output that the README's tables were read from:
//
//   bun docs/research/34_non_http_host/summarize.mjs results/<set>/<file>.txt [...]
//
// Reach cells, per target: f fetch, x XHR, i <img>, s <script> or importScripts(); R read (or ran), L loaded (an image),
// - refused or error, ? no answer, r loaded but did not run.
import { readFileSync } from 'node:fs';

const code = (v) => {
    if (v === undefined) return '';
    const s = String(v);
    if (s.startsWith('read') || s.startsWith('ran')) return 'R';
    if (s.startsWith('loaded ')) return 'L';
    if (s.startsWith('loaded, did not run')) return 'r';
    if (s.startsWith('no answer')) return '?';
    return '-';
};
const cell = (r) => `f${code(r.fetch)} x${code(r.xhr)}${r.img !== undefined ? ` i${code(r.img)}` : ''}${r.script !== undefined ? ` s${code(r.script)}` : ''}${r.importScripts !== undefined ? ` s${code(r.importScripts)}` : ''}`;
const reach = (o) => (o && typeof o === 'object' ? Object.entries(o).map(([k, r]) => `${k}[${cell(r)}]`).join(' ') : String(o));
const broken = (g) => Object.entries(g || {}).filter(([, v]) => String(v).startsWith('broken')).map(([k]) => k);
const check = (c) => (c ? (c.clean ? 'clean' : `NOT clean (foreign ${c.foreign}${c.off && c.off.length ? `; off: ${c.off.join(', ')}` : ''})`) : '-');

for (const file of process.argv.slice(2)) {
    console.log(`## ${file}`);
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = /^(\S+) (\{.*\})$/.exec(line);
        if (!m) continue;
        const [tag, o] = [m[1].split('.').pop(), JSON.parse(m[2])];
        if (tag === 'run') console.log(`run: ${o.engine} ${o.version} ${o.date} load ${o.load1}`);
        if (tag === 'host') console.log(`host ${o.kind}: ${o.loaded ? `loaded; origin ${o.env.origin}, secure ${o.env.secure}, subtle ${o.env.subtle}${o.env.runtime ? `, runtime ${o.env.runtime}` : ''}` : `NOT loaded: ${o.error}`}`);
        if (tag === 'controls') console.log(`  controls page: ${reach(o.page)}\n  controls worker: ${typeof o.worker === 'object' ? reach(o.worker.reach) : o.worker}`);
        if (tag === 'check') {
            const r = (x) => (typeof x !== 'object' ? x : x.throws || x.error ? `fails (${x.throws || x.error}${x.message ? ': ' + x.message : ''})` : `${x.status} ${x.type} ${x.bytes} B, digest ${x.digest}`);
            console.log(`  check [${o.label}] subtle ${o.subtle}: fetch ${r(o.fetch)}; xhr ${r(o.xhr)}`);
        }
        if (tag === 'case') {
            console.log(`  case [${o.case}]: ${o.end} (${o.ms} ms), loads ${JSON.stringify(o.loads)}${o.hostViolations.length ? `, host violations ${JSON.stringify(o.hostViolations)}` : ''}`);
            console.log(`    F: ${o.F ? `origin ${o.F.origin}, secure ${o.F.secure}, chrome ${o.F.chrome}${o.F.runtime ? ` (runtime ${o.F.runtime})` : ''}, guard passes ${o.F.guardPasses}` : 'no diagnostic (F ran no script)'}`);
            if (o.C) console.log(`    C: origin ${o.C.env.origin}, secure ${o.C.env.secure}, subtle ${o.C.env.subtle}, chrome ${o.C.env.chrome}; hash ${o.C.hash.slice(0, 20)}; gates broken [${broken(o.C.gates)}]; check ${check(o.C.check)}`);
            if (o.W) console.log(`    W: started ${o.W.started}${o.W.env ? `, origin ${o.W.env.origin}, href ${o.W.env.href.slice(0, 12)}` : ''}; gates broken [${broken(o.W.gates)}]; check ${check(o.W.check)}`);
            if (o.C) console.log(`    port ${o.portConnected ? 'connected' : 'NOT connected'}; foreign events ${JSON.stringify((o.foreignEvents || []).map((e) => `${e.dir} ${e.disp} [${String(e.policy).slice(0, 60)}]`))}`);
            if (o.reach) console.log(`    reach C: ${reach(o.reach.C)}\n    reach W: ${typeof o.reach.W === 'object' ? reach(o.reach.W.reach) : o.reach.W}`);
        }
        if (tag === 'library') console.log(`  library [${o.label}]: ${o.error ? `page error ${o.error}` : typeof o.result === 'string' ? o.result : `${o.result.state ?? ''} ${o.result.call ?? ''} ${o.result.threw ?? ''}`.trim()}${o.errors && o.errors.length ? `; errors ${JSON.stringify(o.errors).slice(0, 300)}` : ''}${o.console && o.console.length ? `; console ${JSON.stringify(o.console).slice(0, 400)}` : ''}`);
        if (tag === 'error') console.log(`ERROR ${o.error}`);
    }
}
