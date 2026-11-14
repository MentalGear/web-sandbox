// Research 26: reads results/*.txt and prints the figures the README's tables are made from (medians and ranges).
//   bun docs/research/26_interpreter_logic_tier/summarize.mjs [q1|q2|q3|q4|q5|q6]
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { median, range } from './lib.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const only = process.argv[2];
const lines = [];
for (const file of readdirSync(dir).sort()) {
    for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n')) {
        const at = line.indexOf(' {');
        if (at < 0) continue;
        try { lines.push({ tag: line.slice(0, at), file, ...JSON.parse(line.slice(at + 1)) }); } catch { /* not a result line */ }
    }
}
const of = (tag) => lines.filter((l) => l.tag === tag);
const stat = (xs) => (xs.length ? `${median(xs)} (${range(xs)})` : '–');
const show = (q) => !only || only === q;

if (show('q1')) for (const l of of('q1')) console.log('q1', l.engine, l.bundle, l.host, l.view, l.runs ? 'RUNS' : 'no', (l.error ?? '').slice(0, 90), 'worker:', l.workerViolations?.join('|'), 'doc:', l.documentViolations?.join('|'), l.load);

if (show('q2')) {
    for (const l of of('q2.watchdog')) console.log('wd', l.engine, l.op, 'durations', l.durations?.join(' '), 'overshoots', l.overshoots?.join(' '), l.interrupted, 'usable', l.usableAfter, 'turnsBetweenPolls', l.turnsBetweenPolls, l.error ?? '', l.load);
    for (const l of of('q2.cpu')) console.log('cpu', l.engine, l.op, l.form, l.wired ? 'wired' : 'unwired', l.how, 'busy', l.whileLooping, 'idleMs', l.idleMsAfterStop, 'afterRemoval', l.idleAfterRemoval ?? '', 'close', l.afterPageClose, l.error ?? '', l.load);
}
if (show('q3')) for (const l of of('q3')) console.log('q3', l.engine, l.limitMiB, l.wasmMaxMiB, l.content, JSON.stringify(l.result), l.workerThrew ?? '', 'ms', l.ms, 'usable', JSON.stringify(l.usableAfter), 'ctx', JSON.stringify(l.newContextAfter), 'mod', JSON.stringify(l.newModuleAfter), 'wasmMiB', l.wasmMemoryMiB, 'stall', l.hostStallMs, 'alive', l.hostAlive, l.workerErrors?.join('|') ?? '', l.error ?? '', l.load);
if (show('q4')) {
    for (const engine of ['chromium', 'firefox', 'webkit']) {
        for (const bundle of ['worker-wasm.min.js', 'worker-asmjs.min.js']) {
            const rs = of('q4').filter((l) => l.engine === engine && l.bundle === bundle && !l.error);
            if (!rs.length) continue;
            const out = { engine, bundle, runs: rs.length, load: rs.map((r) => r.load.split(' ')[0]).join(' ') };
            out.nativeSpawnMs = stat(rs.map((r) => r.nativeSpawnMs));
            out.spawnMs = stat(rs.map((r) => r.spawnMs));
            out.coldMs = stat(rs.map((r) => r.startup.coldMs));
            out.compileMs = stat(rs.map((r) => r.startup.compileMs).filter((x) => x !== undefined));
            out.warmMs = stat(rs.map((r) => median(r.startup.warmInstanceMs)));
            out.newContextMs = stat(rs.map((r) => median(r.startup.newContextMs)));
            for (const b of ['loop', 'render', 'json']) {
                out[`${b}.native`] = stat(rs.map((r) => r.speed[b].nativeMs));
                out[`${b}.interp`] = stat(rs.map((r) => r.speed[b].interpMs));
                out[`${b}.ratio`] = stat(rs.map((r) => r.speed[b].ratio));
                out[`${b}.same`] = rs.every((r) => r.speed[b].same);
            }
            const turn = (r, k) => median(r.app[k].times);
            out['turn.native'] = stat(rs.map((r) => turn(r, 'native')));
            out['turn.interp'] = rs.every((r) => r.app.interp.times) ? stat(rs.map((r) => turn(r, 'interp'))) : rs.map((r) => r.app.interp.error).join('|');
            out['turn.ratio'] = rs.every((r) => r.app.interp.times) ? stat(rs.map((r) => Math.round((turn(r, 'interp') / turn(r, 'native')) * 10) / 10)) : '–';
            console.log('q4', JSON.stringify(out));
        }
    }
    for (const l of of('q4').filter((x) => x.error)) console.log('q4 error', l.engine, l.bundle, l.error);
}
if (show('q5')) for (const l of of('q5')) console.log('q5', l.engine, l.kind, 'run', l.run, 'busy', l.busy, 'mean', l.meanBusy, JSON.stringify(l.progress), l.errors?.length ? JSON.stringify(l.errors).slice(0, 200) : '', l.load);
if (show('q6')) {
    for (const l of of('q6.reach')) console.log('reach', l.engine, 'globals', l.globals?.length, 'present', l.allowlistPresent?.length, 'of', l.allowlistSize, 'eval', l.evalInside?.value, 'ctor', l.constructorEscape?.value, 'import', l.dynamicImport, 'date step', l.dateNowStepMs?.value, 'violations', l.workerViolations?.length, l.documentViolations?.length, 'reports', l.reports?.length);
    for (const l of of('q6.control')) console.log('control', l.engine, l.workerNativeEval, l.viewEval, 'worker events', l.workerViolations?.length, 'doc events', l.documentViolations?.length, 'reports', l.reports?.length);
    for (const l of of('q6.boundary')) console.log('boundary', l.engine, Object.entries(l).filter(([, v]) => v && typeof v === 'object' && 'evalMs' in v).map(([k, v]) => `${k}: host ${v.host?.ms}ms ${v.host?.sample?.slice(0, 20) ?? v.host?.threw ?? ''} (${v.eval})`).join('; '), 'getters', l.getterSideEffects, 'traps', l.proxyTraps);
}
