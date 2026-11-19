// Prints the compact view of a research 28 results set that the README's tables were read from.
//
//   bun docs/research/28_served_topology/summarize.mjs <set> [prefix]     # e.g. 2026-11-15_pw-1.65.1 q1
//
// q1 lines: per case and realm (F, C, W_C, W_F), the origin and what of the origin's authority the realm reached (a
// check's answer that shows access: the host's cookies, its localStorage value, its IndexedDB database, its cache, a
// Service Worker registration, OPFS, a storage estimate, Web Locks, a granted permission, a readable parent, top or
// opener document, a BroadcastChannel message the host tab received, a request whose response the realm read, and
// which host cookies a request carried to the server). Other prefixes print their lines unchanged.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const [set, prefix = ''] = process.argv.slice(2);
if (!set) { console.error('usage: summarize.mjs <set> [prefix]'); process.exit(1); }

const REACHED = {
    cookieRead: (v) => /^reads host/.test(v),
    cookieWrite: (v) => v === 'written',
    localStorage: (v) => v === 'host value',
    sessionStorage: (v) => v === 'accessible',
    parentDocument: (v) => v === 'readable',
    topDocument: (v) => v === 'readable',
    openerDocument: (v) => v === 'readable',
    indexedDB: (v) => v === 'opened',
    indexedDBHost: (v) => v === 'lists hostdb',
    caches: (v) => /^has hostcache|^opened/.test(v),
    storageEstimate: (v) => v === 'answers',
    opfs: (v) => v === 'directory',
    serviceWorker: (v) => /^[1-9]\d* registrations/.test(v),
    locks: (v) => v === 'answers',
    permission: (v) => v === 'granted',
    fetch: (v) => /^read/.test(v),
    xhr: (v) => /^read/.test(v),
};

function realm(r, kind, line) {
    if (!r || typeof r !== 'object') return `${kind}: ${JSON.stringify(r)}`;
    const reached = [];
    for (const [k, test] of Object.entries(REACHED)) if (k in r && test(r[k])) reached.push(k === 'caches' && r[k].startsWith('opened') ? 'caches(own)' : k);
    for (const [where, from] of Object.entries(line.broadcast ?? {})) if (from.includes(kind)) reached.push(`broadcast->${where}`);
    for (const q of line.requests ?? []) if (q.q.endsWith(`=${kind}`) && q.cookie) reached.push(`${q.q.split('=')[0]} sent cookie {${q.cookie}}`);
    return `${kind} ${r.origin === 'null' ? 'opaque' : 'REAL'}${r.secure ? '' : ' (not secure)'}: ${reached.length ? reached.join(' ') : '-'}`;
}

for (const file of readdirSync(path.join(dir, set)).sort()) {
    if (!file.startsWith(prefix)) continue;
    console.log(`== ${file}`);
    for (const text of readFileSync(path.join(dir, set, file), 'utf8').split('\n')) {
        const m = /^(\S+) (\{.*\})$/.exec(text);
        if (!m) { if (text.trim()) console.log(text.slice(0, 300)); continue; }
        const [, tag, json] = m;
        const line = JSON.parse(json);
        if (tag !== 'q1' || !line.R) { console.log(`${tag} ${json.slice(0, 600)}`); continue; }
        const R = line.R;
        console.log(`[${line.connect}] ${line.case}`);
        for (const k of ['F', 'C', 'WC', 'WF']) console.log(`    ${realm(R[k], k, line)}`);
        const sent = (line.requests ?? []).map((q) => `${q.q}${q.cookie ? ' {' + q.cookie + '}' : ''} site=${q.site}`);
        if (sent.length) console.log(`    server saw: ${sent.join('; ')}`);
        console.log(`    shown: ${JSON.stringify(line.childText).slice(0, 60)} at ${line.topUrl.slice(0, 50)}`);
    }
}
