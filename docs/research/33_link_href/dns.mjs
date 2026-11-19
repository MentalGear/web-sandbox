// The DNS side of research 33: runs probe.mjs with `--dns` (the listed host bypasses the proxy, so the browser resolves
// it itself) under strace, and files every DNS query for a listed host by its name (the trial is in the name) and its
// time (the phase windows are in the probe's output).
//
//   node docs/research/33_link_href/dns.mjs <config> <out-prefix> [probe args…]
//
// Writes <out-prefix>.jsonl (the probe's lines) and <out-prefix>.dns.jsonl (one line per trial: the queries filed by
// phase), and keeps no strace log (it holds every syscall of the browser). What strace sees: every `connect`, `sendto`,
// `sendmsg` and `sendmmsg` of every process of the browser. A query is a datagram to port 53 whose bytes carry the
// listed name in DNS wire format (`\x03t12\x06listed\x07example`), or a connect to port 853 or to a resolver's port 443
// (DNS over TLS or HTTPS, which carry no readable name: filed by time only).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const [config, prefix, ...rest] = process.argv.slice(2);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'r33-strace-'));
const log = path.join(tmp, 'strace.log');
const run = spawnSync('strace', ['-f', '-ttt', '-qq', '-e', 'trace=connect,sendto,sendmsg,sendmmsg', '-e', 'signal=none', '-s', '512', '-xx', '-o', log,
    process.execPath, path.join(dir, 'probe.mjs'), config, '--dns', ...rest], { encoding: 'utf8', maxBuffer: 1 << 28, env: process.env });
writeFileSync(`${prefix}.jsonl`, run.stdout);
if (run.stderr) process.stderr.write(run.stderr.slice(-2000));

// listed names in wire format, from the hex strace prints with -xx
const hexToBytes = (s) => Buffer.from(s.replace(/\\x/g, ''), 'hex');
const queries = [];
const dotQueries = [];
const resolvers = new Set();
for (const line of readFileSync(log, 'utf8').split('\n')) {
    const m = /^(\d+)\s+(\d+\.\d+)\s+(\w+)\((.*)$/.exec(line);
    if (!m) continue;
    const [, pid, ts, call, rest2] = m;
    const t = Math.round(Number(ts) * 1000);
    const port = /sin6?_port=htons\((\d+)\)/.exec(rest2)?.[1];
    const rawAddr = /inet_(?:addr|pton)\((?:AF_INET6, )?"([^"]+)"/.exec(rest2)?.[1];
    const addr = rawAddr && rawAddr.includes('\\x') ? hexToBytes(rawAddr).toString('latin1') : rawAddr;
    if (call === 'connect' && port === '53') resolvers.add(addr);
    if (call === 'connect' && (port === '853' || (port === '443' && resolvers.has(addr)))) dotQueries.push({ t, pid, addr, port });
    for (const hm of rest2.matchAll(/"((?:\\x[0-9a-f]{2})+)"/g)) {
        const b = hexToBytes(hm[1]);
        const i = b.indexOf(Buffer.from('\x06listed\x07example', 'latin1'));
        if (i < 0) continue;
        // the label before "listed" is the trial's (t12)
        let label = null;
        for (let j = i - 1; j >= 0; j--) if (b[j] === i - j - 1 && i - j - 1 > 0) { label = b.subarray(j + 1, i).toString('latin1'); break; }
        const qtype = b.length >= i + 18 ? b.readUInt16BE(i + 16) : null;
        queries.push({ t, pid, call, label, qtype });
    }
}
rmSync(tmp, { recursive: true, force: true });

const out = [];
for (const line of run.stdout.split('\n')) {
    if (!line.startsWith('r33 ')) continue;
    const r = JSON.parse(line.slice(4));
    const phases = r.phases;
    const phaseAt = (t) => { let p = 'before'; for (const [name, at] of phases) if (t >= at) p = name; return p; };
    const start = phases[0][1];
    const end = phases[phases.length - 1][1] + 500;
    const mine = queries.filter((q) => q.label === `t${r.trial}`);
    const byPhase = {};
    for (const q of mine) { const p = phaseAt(q.t); byPhase[p] = (byPhase[p] ?? 0) + 1; }
    const enc = dotQueries.filter((q) => q.t >= start && q.t <= end).map((q) => phaseAt(q.t));
    out.push({ config: r.config, layout: r.layout, case: r.case, trial: r.trial, headed: r.headed, queries: byPhase, encryptedDnsConnects: enc, diag: r.diag, notes: r.notes });
}
const stray = queries.filter((q) => !/^t\d+$/.test(q.label ?? ''));
writeFileSync(`${prefix}.dns.jsonl`, `${out.map((o) => JSON.stringify(o)).join('\n')}\n${JSON.stringify({ resolvers: [...resolvers], strayQueries: stray.length, totalQueries: queries.length })}\n`);
console.log(`trials ${out.length}, listed queries ${queries.length}, resolvers ${[...resolvers].join(' ')}, exit ${run.status}`);
