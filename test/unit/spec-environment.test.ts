import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No e2e spec or research probe writes process.env. Playwright imports every spec of a run, and the browsers it starts
 * inherit the process's environment, so a write in one file reaches every browser of the run: an empty entry in
 * NO_PROXY with no proxy set makes WebKit fail every page load. A spec that needs another environment for its own
 * browsers passes it as `test.use({ launchOptions: { env } })` (docs/research/21_crossorigin_loads/server.ts, browserEnv).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIRS = ['test/e2e', 'docs/research'];
const WRITE = /process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*(?:=(?!=)|\+=|\?\?=|\|\|=)|delete\s+process\.env/;

function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) { if (name !== 'node_modules' && name !== 'results') out.push(...files(full)); }
        else if (/\.(ts|mts|js|mjs)$/.test(name)) out.push(full);
    }
    return out;
}

describe('specs and probes leave the run\'s environment as it is', () => {
    it('no file under test/e2e or docs/research writes or deletes process.env', () => {
        const writers = DIRS.flatMap(dir => files(path.join(ROOT, dir)))
            .flatMap(file => readFileSync(file, 'utf8').split('\n').map((line, i) => ({ file: path.relative(ROOT, file), line: i + 1, text: line })))
            .filter(({ text }) => WRITE.test(text) && !/^\s*(\/\/|\*)/.test(text))
            .map(({ file, line, text }) => `${file}:${line}: ${text.trim()}`);
        expect(writers, 'pass the environment to the spec\'s own browsers as launchOptions.env instead').toEqual([]);
    });

    it('the scan sees a write (positive control)', () => {
        expect(WRITE.test("process.env['NO_PROXY'] = ',.test';")).toBe(true);
        expect(WRITE.test('process.env.NO_PROXY ??= ".test";')).toBe(true);
        expect(WRITE.test('delete process.env.HTTPS_PROXY;')).toBe(true);
        expect(WRITE.test('const port = process.env.PORT ?? 4444;')).toBe(false);
        expect(WRITE.test('if (process.env.CI === "true") {}')).toBe(false);
    });
});
