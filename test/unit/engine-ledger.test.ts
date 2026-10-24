import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_DIFFERENCE_IDS, ENGINE_DIFFERENCES } from '@src/lib/engine-ledger';
import { COOKIE_ENGINE_FACTS } from '@src/lib/cookie-facts';
import { CONNECT_ENGINE_FACTS } from '@src/lib/connect-facts';
import { citedAnywhere, engineSites, unledgered, WINDOW } from './engine-ledger-scan';

/**
 * The engine-difference ledger (src/lib/engine-ledger.ts) and its scan. An engine difference cannot enter the suite
 * silently: every `browserName`-dependent branch, per-engine map or `engines:` override under test/e2e/ cites the row
 * it belongs to (`// ledger: <id>`), a cited id is a row, and every row is cited by each spec it names. A branch with no
 * row is a difference nobody decided to keep: make it uniform, or give it a row.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KNOWN = new Set<string>(ENGINE_DIFFERENCE_IDS);

const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const e2eFiles = (): string[] => (readdirSync(path.join(ROOT, 'test/e2e'), { recursive: true }) as string[])
    .filter(file => file.endsWith('.ts')).sort().map(file => `test/e2e/${file}`);

describe('the ledger', () => {
    it('has rows that say what differs, what each engine does, why it stays and where it is pinned', () => {
        expect(ENGINE_DIFFERENCE_IDS.length).toBeGreaterThan(0);
        for (const id of ENGINE_DIFFERENCE_IDS) {
            const row = ENGINE_DIFFERENCES[id];
            expect(id, id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
            for (const field of ['what', 'chromium', 'firefox', 'webkit', 'why'] as const) expect(row[field].trim(), `${id}.${field}`).not.toBe('');
            expect(row.tests.length, `${id}.tests`).toBeGreaterThan(0);
            for (const test of row.tests) expect(existsSync(path.join(ROOT, test)), `${id}: ${test}`).toBe(true);
        }
    });

    it('states the cookie and connect-src rows from the tables that own those values', () => {
        for (const engine of Object.keys(COOKIE_ENGINE_FACTS) as (keyof typeof COOKIE_ENGINE_FACTS)[]) {
            const sent = COOKIE_ENGINE_FACTS[engine].sends.sameSite;
            expect(ENGINE_DIFFERENCES.cookies[engine], engine).toContain(sent.length === 0 ? 'none' : `SameSite=${sent[0]}`);
        }
        for (const engine of Object.keys(CONNECT_ENGINE_FACTS) as (keyof typeof CONNECT_ENGINE_FACTS)[]) {
            expect(ENGINE_DIFFERENCES['connect-src'][engine], engine).toContain(CONNECT_ENGINE_FACTS[engine].selfAdmitsOtherOrigins ? "`'self'` source admits" : "`'self'` source does not admit");
        }
    });

    it('is cited by every spec it names, and by no spec it does not name', () => {
        const citedBy = new Map<string, Set<string>>();
        for (const file of e2eFiles()) for (const id of citedAnywhere(read(file))) citedBy.set(id, (citedBy.get(id) ?? new Set()).add(file));
        const problems: string[] = [];
        for (const id of ENGINE_DIFFERENCE_IDS) {
            const row = ENGINE_DIFFERENCES[id];
            for (const test of row.tests) if (!citedBy.get(id)?.has(test)) problems.push(`${id}: ${test} does not cite it`);
            for (const file of citedBy.get(id) ?? []) if (!(row.tests as readonly string[]).includes(file)) problems.push(`${id}: ${file} cites it but the row does not name that spec`);
        }
        expect(problems).toEqual([]);
    });
});

/**
 * The research specs (docs/research/NN_*) run in the same Playwright projects, and some branch on the engine (BD3:TST-8).
 * They are reproductions and design probes that record what each engine does for the research they belong to, not pins of the
 * library's behaviour, so their branches cite no row; a spec that is not on this list has none, or cites its rows like the
 * suite's. A research spec that starts to branch on the engine fails here until it is listed (with why) or cites a row.
 */
const RESEARCH_PROBES: Readonly<Record<string, string>> = {
    'docs/research/11_meta_csp_delivery/reproduce.spec.ts': 'asserts on the text of the console warning Chromium prints, and skips elsewhere',
    'docs/research/12_non_fallback_directives/reproduce.spec.ts': 'records which engine refuses a form-action target',
    'docs/research/13_popup_exfiltration/reproduce.spec.ts': 'records the popup an opt-in allows, which Chromium refuses without an opener',
    'docs/research/15_strict_mode/probe.spec.ts': "the design probes ADR-005 rests on, each recording per engine what the design was measured against (the file's header says so)",
    'docs/research/19_relay_worker/probe.spec.ts': 'on-demand measurements of the relay worker per engine',
};

describe('the scan of docs/research (BD3:TST-8)', () => {
    const researchFiles = (): string[] => (readdirSync(path.join(ROOT, 'docs/research'), { recursive: true }) as string[])
        .filter(file => file.endsWith('.spec.ts')).sort().map(file => `docs/research/${file}`);

    it('a research spec that branches on the engine is listed as a probe, or cites a ledger row', () => {
        expect(researchFiles().length).toBeGreaterThan(10);
        const problems = researchFiles().filter(file => !(file in RESEARCH_PROBES)).flatMap(file => unledgered(file, read(file), KNOWN));
        expect(problems).toEqual([]);
    });

    it('every probe on the list exists and is still one that branches on the engine (the list does not keep a spec that no longer needs it)', () => {
        for (const [file, why] of Object.entries(RESEARCH_PROBES)) {
            expect(existsSync(path.join(ROOT, file)), file).toBe(true);
            expect(why.length, file).toBeGreaterThan(20);
        }
        const branching = researchFiles().filter(file => engineSites(read(file)).length > 0);
        expect(branching).toEqual(Object.keys(RESEARCH_PROBES).sort());
    });
});

describe('the scan of test/e2e', () => {
    it('finds the engine branches, per-engine maps and overrides, and every one cites a ledger row', () => {
        const sites = e2eFiles().flatMap(file => engineSites(read(file)).map(site => ({ file, ...site })));
        // a floor, not a count to keep: the scan must see the suite's branches (the ledger began with about 58 sites)
        expect(sites.length).toBeGreaterThanOrEqual(58);
        expect(e2eFiles().flatMap(file => unledgered(file, read(file), KNOWN))).toEqual([]);
    });

    describe('flags a branch that cites no row', () => {
        const flagged = (source: string) => unledgered('test/e2e/example.spec.ts', source, KNOWN);

        it('a comparison with browserName', () => {
            expect(flagged("test('x', async ({ browserName }) => {\n    if (browserName === 'webkit') expect(1).toBe(1);\n});")).toEqual([
                "test/e2e/example.spec.ts:2: cites no ledger row: if (browserName === 'webkit') expect(1).toBe(1);",
            ]);
            expect(flagged("const v = browserName !== 'firefox' ? 1 : 2;")).toHaveLength(1);
            expect(flagged("test.skip(({ browserName }) => browserName !== 'chromium', 'a Chromium feature');")).toHaveLength(1);
        });

        it('a lookup by browserName, a per-engine map, an includes and an engines override', () => {
            expect(flagged('const x = TABLE[browserName];')).toHaveLength(1);
            expect(flagged("const x = { chromium: 1, firefox: 2, webkit: 3 };")).toHaveLength(1);
            expect(flagged("const x = {\n    chromium: 1,\n    firefox: 2,\n};")).toHaveLength(2);
            expect(flagged('const csp = (list: string[]) => (list.includes(browserName) ? 1 : 0);')).toHaveLength(1);
            expect(flagged("{ header: 'coep', outcome: works(), engines: { webkit: ends('x') } },")).toHaveLength(1);
            expect(flagged("csp('script-src-elem', ['chromium'])")).toHaveLength(1);
        });

        it('the other ways to name the engine: the project\'s name, an alias, a rename, a switch, a method, a regular expression, the user agent (BD3:TST-8)', () => {
            for (const source of [
                "if (testInfo.project.name === 'webkit') {}",
                "const flag = test.info().project.name !== 'firefox';",
                "const table = { a: 1 }[testInfo.project.name];",
                'const engine = browserName;\nif (engine === "webkit") {}',
                'test("x", async ({ browserName: engine }) => {});',
                'switch (browserName) {\n    case "webkit": break;\n}',
                "if (browserName.startsWith('web')) {}",
                'if (/webkit/.test(browserName)) {}',
                "const isWebKit = await page.evaluate(() => /AppleWebKit/.test(navigator.userAgent));",
            ]) expect(flagged(source), source).toHaveLength(1);
        });

        it('a citation of an id that is not a row', () => {
            expect(flagged("// ledger: no-such-row\nif (browserName === 'webkit') {}")).toEqual([
                'test/e2e/example.spec.ts:2: cites no-such-row, which is not a ledger row',
            ]);
        });

        it('a citation that stands too far above', () => {
            const far = `// ledger: view-thread\n${'\n'.repeat(WINDOW)}if (browserName === 'webkit') {}`;
            expect(flagged(far)).toHaveLength(1);
            const near = `// ledger: view-thread\n${'\n'.repeat(WINDOW - 1)}if (browserName === 'webkit') {}`;
            expect(flagged(near)).toEqual([]);
        });
    });

    describe('passes what cites a row, and what only passes the engine on', () => {
        const flagged = (source: string) => unledgered('test/e2e/example.spec.ts', source, KNOWN);

        it('a citation above, on the line, or in a list', () => {
            expect(flagged("// ledger: view-thread\nif (browserName === 'webkit') {}")).toEqual([]);
            expect(flagged("if (browserName === 'webkit') {} // ledger: view-thread")).toEqual([]);
            expect(flagged("// ledger: view-thread, cookies (two rows)\nconst x = { chromium: 1, firefox: 2 };")).toEqual([]);
        });

        it('browserName passed on, in a call or in an argument list, is not a site (the callee that compares it is)', () => {
            expect(flagged('await waitInView(sandbox.page, test.info().project.name, "x");')).toEqual([]);
            expect(flagged('const result = await inView(page, browserName, "x");')).toEqual([]);
            expect(flagged('const label = `${mode} on ${browserName}`;')).toEqual([]);
        });

        it('browserName passed as an argument, mentioned in a comment, or only named in a message', () => {
            expect(flagged("await waitInView(page, browserName, 'x');")).toEqual([]);
            expect(flagged("const a = await inFrames(page, browserName, 'innerHeight');")).toEqual([]);
            expect(flagged("// browserName === 'webkit' is the branch below")).toEqual([]);
            expect(flagged(" * on all three engines: chromium: ok")).toEqual([]);
            expect(flagged('expect(x, `${mode} on ${browserName}`).toBe(1);')).toEqual([]);
            expect(flagged("log({ webkit: typeof webkitRTCPeerConnection });")).toEqual([]);
        });
    });
});
