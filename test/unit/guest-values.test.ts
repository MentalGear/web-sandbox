import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDS, type Build } from '@src/lib/build-flag';

/**
 * The values the public API hands the embedder, against each build's API report (design 02, "`unknown` for guest
 * values"): a value of the guest's that the library does not check is `unknown` in the report, and no type parameter
 * lets a caller assert a type nothing checks.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORTS: Record<Build, string> = { default: 'etc/web-sandbox.api.md', network: 'etc/web-sandbox.network.api.md' };
const readReport = (build: Build) => readFileSync(path.join(ROOT, REPORTS[build]), 'utf8').replace(/\r\n/g, '\n');

describe('a guest value the library does not check is unknown in the API report, with no type parameter', () => {
    // [the report's line, as it must read]
    const UNKNOWN: readonly string[] = [
        '    call(method: string, ...args: unknown[]): Promise<unknown>;',
        '    callWithTimeout(timeoutMs: number, method: string, ...args: unknown[]): Promise<unknown>;',
        'export type HostMethod = (...args: unknown[]) => unknown;',
        '    args: readonly unknown[];',
    ];

    it.each(BUILDS)('the %s build', (build) => {
        const report = readReport(build);
        for (const line of UNKNOWN) expect(report.split('\n'), line).toContain(line);
        expect(report).not.toMatch(/\bcall(?:WithTimeout)?</);
    });
});
