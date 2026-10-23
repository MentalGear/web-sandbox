import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BARE_HOST_READINGS, CONNECT_ENGINE_FACTS, CONNECT_ENGINES, connectSentence, enginesWhere, nameList } from '@src/lib/connect-facts';
import { CONTEXT_ENGINES, INHERITED_CONTEXT } from '@src/lib/inherited-context';

/**
 * The engine-facts table for `connect-src` (src/lib/connect-facts.ts): the one place that says which engine narrows a
 * sandbox document by the host page's policy, which one lets a `wss://` source admit `https://`, and what the read's decoy
 * logs. The docs are rendered from it; no document states an engine's behaviour in words of its own, which is what this
 * file keeps.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('CONNECT_ENGINE_FACTS', () => {
    it('has a row for every engine of the suite, with every fact a boolean and a measurement', () => {
        expect([...CONNECT_ENGINES]).toEqual([...CONTEXT_ENGINES]);
        for (const engine of CONNECT_ENGINES) {
            const facts = CONNECT_ENGINE_FACTS[engine];
            expect(facts.name, engine).not.toBe('');
            expect(facts.measured, engine).toMatch(/^2026-10-23, Playwright 1\.58\.1/);
            for (const fact of ['selfAdmitsOtherOrigins', 'upgradedSchemeWithPort', 'wssSourceAdmitsHttps', 'decoyRefused', 'decoyLogsWhenAdmitted'] as const) expect(typeof facts[fact], `${engine} ${fact}`).toBe('boolean');
            expect(BARE_HOST_READINGS as readonly string[], engine).toContain(facts.bareHostAdmitted);
        }
    });

    it("is what was measured: only WebKit lets a 'self' source admit other origins and a wss:// source admit https://; every engine refuses the decoy", () => {
        expect(enginesWhere('selfAdmitsOtherOrigins')).toEqual(['WebKit']);
        expect(enginesWhere('upgradedSchemeWithPort', false)).toEqual(['Chromium']);
        expect(Object.values(CONNECT_ENGINE_FACTS).map(facts => facts.bareHostAdmitted)).toEqual(['yes, not with a port', 'yes', 'no']);
        expect(enginesWhere('wssSourceAdmitsHttps')).toEqual(['WebKit']);
        expect(enginesWhere('decoyRefused')).toEqual(['Chromium', 'Firefox', 'WebKit']);
        expect(enginesWhere('decoyLogsWhenAdmitted')).toEqual(['Chromium', 'WebKit']);
    });

    it('the library does not rest on a fact about one engine: the rules it applies are not conditional on the table', () => {
        // src/ reads no engine: the table is for the docs and the e2e specs, which assert the same outcome on every engine
        for (const file of ['src/host.ts', 'src/lib/csp/host-connect.ts', 'src/lib/host-csp.ts', 'src/lib/csp/origins.ts']) {
            const code = readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
            expect(code, file).not.toMatch(/CONNECT_ENGINE_FACTS|navigator\.userAgent|browserName/);
        }
    });
});

describe('the sentences rendered from it', () => {
    it('list engines with a final "and", and "no engine" for none', () => {
        expect(nameList([])).toBe('no engine');
        expect(nameList(['WebKit'])).toBe('WebKit');
        expect(nameList(['Chromium', 'Firefox'])).toBe('Chromium and Firefox');
        expect(nameList(['Chromium', 'Firefox', 'WebKit'])).toBe('Chromium, Firefox and WebKit');
    });

    it('the README sentence names the engines of each fact, from the table', () => {
        expect(connectSentence()).toContain("admits origins it does not name in WebKit only");
        expect(connectSentence()).toContain('also admits `https://host` requests in WebKit only');
    });
});

describe('the row of INHERITED_CONTEXT it explains', () => {
    it('cspFetch: the library neutralises the host page\'s connect-src itself, in every engine, and says so with a unit test and an e2e spec', () => {
        const row = INHERITED_CONTEXT.cspFetch;
        expect([...row.by]).toContain('refuse');
        expect([...row.engines]).toEqual(['chromium', 'firefox', 'webkit']);
        expect(row.how).toMatch(/connect-src/);
        expect([...row.tests]).toEqual(expect.arrayContaining(['test/unit/host-connect.test.ts', 'test/e2e/connect-uniform.spec.ts']));
    });
});

describe("no document states an engine's connect-src or wss:// behaviour outside a generated region", () => {
    const DOCUMENTS = ['README.md', 'SECURITY.md', 'ARCHITECTURE.md', ...readdirSync(path.join(root, 'docs')).filter(file => file.endsWith('.md') && file !== 'BACKLOG.md').map(file => `docs/${file}`)];
    const ENGINE = /\b(chromium|firefox|webkit|safari)\b/i;
    const SUBJECT = /wss:\/\/|\bwss\b|(host page's|your|the page's) `?connect-src|inherited (policy|list|connect)/i;

    /** The lines of a Markdown file outside its generated regions and fenced code, with their numbers. */
    function prose(file: string): Array<[number, string]> {
        const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
        const kept: Array<[number, string]> = [];
        let generated = false;
        let fenced = false;
        lines.forEach((line, index) => {
            if (/^<!-- generated:begin /.test(line)) generated = true;
            else if (line === '<!-- generated:end -->') generated = false;
            else if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
            else if (!generated && !fenced) kept.push([index + 1, line]);
        });
        return kept;
    }

    it.each(DOCUMENTS)('%s', (file) => {
        const offending = prose(file).filter(([, line]) => ENGINE.test(line) && SUBJECT.test(line) && !/cookie/i.test(line));
        expect(offending.map(([number, line]) => `${file}:${number}: ${line.trim().slice(0, 140)}`)).toEqual([]);
    });
});
