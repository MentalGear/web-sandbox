import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import { generate, shrink } from '../model/generator';
import { OPS, STATES, type Cmd, type Sequence } from '../model/lifecycle-model';
import type { RunResult } from '../model/runner';

/**
 * The model-based lifecycle suite (backlog S61.2, S65): seeded sequences of operations, guest steps and re-entrant
 * listener plans run against the real element, every step checked against the reference model in test/model/ (see
 * docs/research/17_formal_methods/lifecycle-model.md).
 *
 * - CI: MODEL_RUNS_DEFAULT sequences per engine (about a minute).
 * - Nightly: `WEB_SANDBOX_MODEL_RUNS=<n>` sequences per engine; `WEB_SANDBOX_MODEL_SEED=<s>` moves the first seed.
 * - A divergence is shrunk (delta debugging over the commands, then the plans) and printed as a minimal repro with its
 *   seed; `WEB_SANDBOX_MODEL_REPRO='<json>'` runs one printed sequence again.
 */

const MODEL_RUNS_DEFAULT = 40;
const RUNS = Math.max(1, Number(process.env.WEB_SANDBOX_MODEL_RUNS) || MODEL_RUNS_DEFAULT);
const FIRST_SEED = Number(process.env.WEB_SANDBOX_MODEL_SEED) || 1;
const CHUNK = 10; // sequences per test, so the workers share a long run

async function runInPage(sandbox: SandboxDriver, sequence: Sequence): Promise<RunResult> {
    return sandbox.page.evaluate(async (sequence) => {
        const url = '/test/model/runner.ts';
        const runner = await import(/* @vite-ignore */ url);
        return runner.runSequence(sequence);
    }, sequence);
}

function report(sequence: Sequence, result: RunResult, browserName: string): string {
    return [
        `DIVERGENCE on ${browserName}, seed ${sequence.seed} (${sequence.mode} mode), at step ${result.step}: ${result.divergence}`,
        `minimal repro (WEB_SANDBOX_MODEL_REPRO): ${JSON.stringify(sequence)}`,
        'trace:',
        ...result.trace,
    ].join('\n');
}

// One sequence, shrunk on a divergence; returns the report of the minimal repro, or null.
async function check(sandbox: SandboxDriver, sequence: Sequence, browserName: string, coverage: Set<string>): Promise<string | null> {
    const result = await runInPage(sandbox, sequence);
    for (const key of result.coverage) coverage.add(key);
    if (result.ok) return null;
    console.log(`seed ${sequence.seed}: ${result.divergence}; shrinking ${sequence.cmds.length} commands`);
    const minimal = await shrink(sequence, async (candidate) => {
        await sandbox.open();
        return !(await runInPage(sandbox, candidate)).ok;
    });
    await sandbox.open();
    const again = await runInPage(sandbox, minimal);
    return report(minimal, again.ok ? result : again, browserName);
}

function coverageLine(coverage: Set<string>, browserName: string, label: string): string {
    const combos = [...coverage].filter(key => /^[a-zA-Z]+\|(idle|loading|ready|terminated)\|/.test(key));
    const modes = new Set(combos.map(key => key.split('|')[2]));
    const total = OPS.length * STATES.length * modes.size;
    return `MEASURED ${browserName} lifecycle model ${label}: ${combos.length} of ${total} (operation, state, mode) combinations reached; ${coverage.size} coverage keys`;
}

test.describe('the lifecycle model', () => {
    test.describe.configure({ mode: 'parallel' });

    const repro = process.env.WEB_SANDBOX_MODEL_REPRO;
    if (repro) {
        test('the given repro', async ({ sandbox, browserName }) => {
            test.setTimeout(120000);
            const sequence = JSON.parse(repro) as Sequence;
            const result = await runInPage(sandbox, sequence);
            expect(result.ok, result.ok ? '' : report(sequence, result, browserName)).toBe(true);
        });
        return;
    }

    for (let start = 0; start < RUNS; start += CHUNK) {
        const seeds = Array.from({ length: Math.min(CHUNK, RUNS - start) }, (_, i) => FIRST_SEED + start + i);
        test(`sequences ${seeds[0]}–${seeds[seeds.length - 1]}`, async ({ sandbox, browserName }) => {
            test.setTimeout(seeds.length * 20000 + 240000);
            const coverage = new Set<string>();
            const failures: string[] = [];
            const began = Date.now();
            for (const seed of seeds) {
                const failure = await check(sandbox, generate(seed), browserName, coverage);
                if (failure) {
                    console.log(failure);
                    failures.push(failure);
                    await sandbox.open();
                }
            }
            console.log(`${coverageLine(coverage, browserName, `seeds ${seeds[0]}–${seeds[seeds.length - 1]}`)} in ${Math.round((Date.now() - began) / 1000)} s`);
            console.log(`COVERAGE ${browserName} ${JSON.stringify([...coverage].sort())}`);
            expect(failures, failures.join('\n\n')).toEqual([]);
        });
    }
});

// Review round 4, L-1: a frame's load completed a build inside the embedder's own appendChild() or remove(). The property:
// remove the element, or move it (within its document, or to a foreign one and back), 12–30 ms into a rebuild, at least
// 100 times per mode, and no `ready` is ever dispatched inside a DOM operation (the model checks every event as usual).
test.describe("round 4's L-1 as a property: no `ready` inside a DOM operation", () => {
    for (const mode of ['cooperative', 'strict', 'worker'] as const) {
        test(`${mode} mode, 120 moves and removals 12–30 ms into a rebuild`, async ({ sandbox, browserName }) => {
            test.setTimeout(180000);
            let seed = 9000 + ['cooperative', 'strict', 'worker'].indexOf(mode);
            const next = () => {
                seed = (seed * 1103515245 + 12345) % 2147483648;
                return seed / 2147483648;
            };
            const cmds: Cmd[] = [
                { op: 'register', files: { 'agent.js': 'AGENT', 'bad.js': 'BAD', 'data.txt': 'data' } },
                {
                    op: 'setConfig',
                    cfg: { kind: 'valid', mode, scriptUnsafe: true, guestWrites: false, watchdog: undefined, execTimeout: undefined, html: 'plain', fetch: false, limits: 'none', variant: 0, ...(mode === 'cooperative' ? { noScripts: true } : {}), ...(mode === 'strict' ? { entry: 'agent.js' as const } : {}) },
                },
                { op: 'insert' },
                { op: 'settle' },
            ];
            for (let i = 0; i < 120; i++) {
                cmds.push({ op: 'insert' }, { op: 'wait', ms: 12 + Math.floor(next() * 19) });
                const roll = next();
                cmds.push(roll < 0.4 ? { op: 'insert' } : roll < 0.8 ? { op: 'remove' } : { op: 'foreign' });
                cmds.push({ op: 'insert' });
                if (i % 30 === 29) cmds.push({ op: 'settle' });
            }
            const result = await runInPage(sandbox, { seed, mode, plans: [], cmds });
            console.log(`MEASURED ${browserName} L-1 property, ${mode} mode: 120 iterations in ${result.ms} ms, ${result.events.ready ?? 0} ready events, none inside a DOM operation${result.ok ? '' : ' (DIVERGED)'}`);
            expect(result.ok, result.ok ? '' : report({ seed, mode, plans: [], cmds }, result, browserName)).toBe(true);
        });
    }
});

// FINDING LM-1, fixed (class L; the lifecycle model, WebKit seed 73 at 500 sequences; made deterministic here). A `fetch`
// record with outcome `ok` of an environment that a `fetch` listener had torn down was dispatched after the teardown, where
// API.md (`fetch` — FetchRecord) says that after its teardown an environment's records are `aborted`. A request whose body
// was already read when the listener of an earlier record tore the environment down recorded `ok`: fetch-bridge.ts looked
// at the teardown only on a throw. It failed at 446017a on Chromium, Firefox and WebKit, in the first round: the three
// later records arrived `ok`. Fixed 2026-10-19 by construction, the owner's decision being `aborted`: the bridge's one
// record() decides the outcome from the bridge's lifetime, so every record made after abortAll() is `aborted`, whatever
// path it settled on (test/unit/fetch-bridge-lifecycle.test.ts enumerates the paths).
test.describe('finding: fetch records after a teardown', () => {
    test('a record dispatched after a fetch listener tore its environment down is `aborted`', async ({ sandbox, page, browserName }) => {
        test.setTimeout(90000);
        expect(await sandbox.mount({ mode: 'cooperative', fetchBridge: { allow: [ORIGIN] } })).toBe('ready');
        const late: string[] = [];
        for (let round = 0; round < 20 && late.length === 0; round++) {
            late.push(...await page.evaluate(async ({ origin, round }) => {
                const el = document.querySelector('web-sandbox') as any;
                const after: string[] = [];
                let torn = false;
                const onFetch = (event: CustomEvent) => {
                    if (torn) {
                        if (event.detail.outcome !== 'aborted') after.push(`${event.detail.url} ${event.detail.outcome}`);
                        return;
                    }
                    torn = true;
                    el.terminate('a fetch listener ends it');
                    el.reset();
                };
                el.addEventListener('fetch', onFetch);
                // the host page's fetch, which the bridge calls, answers the four requests (maxConcurrent) at once: their bodies are read
                // in one task, so the first record's listener tears the environment down while the others are settling
                const realFetch = window.fetch;
                const gate: (() => void)[] = [];
                window.fetch = (() => new Promise<Response>(resolve => {
                    gate.push(() => resolve(new Response(new Uint8Array(70), { status: 200 })));
                    if (gate.length === 4) for (const open of gate) open();
                })) as typeof fetch;
                try {
                    el.execute(`for (let i = 0; i < 4; i++) sandboxFetch('${origin}/test/e2e/pixel.png?round=${round}&i=' + i).catch(() => {});`);
                    await new Promise(resolve => setTimeout(resolve, 400));
                } finally {
                    window.fetch = realFetch;
                }
                if (el.state !== 'ready') await new Promise(resolve => el.addEventListener('ready', resolve, { once: true }));
                el.removeEventListener('fetch', onFetch);
                return after;
            }, { origin: ORIGIN, round }));
        }
        console.log(`MEASURED ${browserName} fetch records after a teardown, not aborted: ${JSON.stringify(late)}`);
        expect(late).toEqual([]);
    });
});
