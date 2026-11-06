import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorName, fixedDetail, joinDetails, reasonText, TERMINATION_REASONS, type ReasonId } from '@src/lib/reasons';
import { renamedModeNote, unknownModeReason } from '@src/lib/config-schema';
import { OriginsTypeError, refusalDetail } from '@src/lib/csp/origins';

/**
 * BD5:DOC-2 (class C): a `terminated` reason names the problem, never a value of the configuration or the guest's. An
 * embedder that took `entry` or `mode` from an app's bundle and showed the reason as markup ran the bundle's markup in
 * its page. The reason table's slots take a LibraryDetail, which only the library's producers make (src/lib/reasons.ts):
 * here every templated reason, and every call site that fills one, is fed hostile values, and the cast that brands a
 * detail is found in reasons.ts alone.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MARKUP = '<img src=x onerror="alert(document.domain)">';
const HOSTILE = [
    MARKUP,
    `"'&%c\n<svg onload=alert(1)>`,
    `${MARKUP}${'A'.repeat(10_000)}`,
    'iframe<script>',
    'iframe toString',
    '../../etc/passwd',
];

/** True when `reason` holds `value`, or any run of 6 or more of its characters. */
const echoes = (reason: string, value: string) => {
    for (let i = 0; i + 6 <= value.length; i++) if (reason.includes(value.slice(i, i + 6))) return true;
    return value.length < 6 && value.length > 0 && reason.includes(value);
};

const task = () => new Promise(resolve => setTimeout(resolve, 0));

async function terminationOf(config: unknown, files?: Record<string, string>): Promise<string[]> {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    const reasons: string[] = [];
    el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
    if (files) el.registerFiles(files);
    el.setConfig(config);
    for (let i = 0; i < 5; i++) await task();
    return reasons;
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const ENTRY_REASON = TERMINATION_REASONS.entryNotRegistered.text;
const MODE_REASON = reasonText('unknownMode', fixedDetail(''));

describe('BD5:DOC-2: a reason never carries a value of the configuration', () => {
    for (const mode of ['strict', 'sealed', undefined] as const) {
        it.each(HOSTILE.map(value => [JSON.stringify(value.slice(0, 40)), value] as const))(`an entry that is not a registered JavaScript file (mode ${mode ?? 'left out'}): %s`, async (_, value) => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const reasons = await terminationOf({ ...(mode ? { mode } : {}), entry: value }, { 'main.js': 'void 0', 'notes.txt': 'x' });
            expect(reasons).toEqual([ENTRY_REASON]);
            for (const reason of reasons) expect(echoes(reason, value), reason).toBe(false);
        });
    }

    it.each(HOSTILE.map(value => [JSON.stringify(value.slice(0, 40)), value] as const))('an unknown mode: %s', async (_, value) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const reasons = await terminationOf({ mode: value });
        expect(reasons).toEqual([MODE_REASON]);
        for (const reason of reasons) expect(echoes(reason, value), reason).toBe(false);
        expect(unknownModeReason(value)).toBe(MODE_REASON);
    });

    it("only the library's own old names get the renamed note, and it is the library's text", () => {
        expect(unknownModeReason('iframe')).toBe(`${MODE_REASON} ('iframe' was renamed 'cooperative')`);
        for (const value of [...HOSTILE, 'constructor', '__proto__', 'Iframe']) expect(renamedModeNote(value)).toBe('');
    });

    it.each(HOSTILE.map(value => [JSON.stringify(value.slice(0, 40)), value] as const))('a config whose getter throws an error named %s: the reason says (Error)', async (_, value) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = { mode: 'strict', get entry() { const error = new Error(MARKUP); error.name = value; throw error; } };
        const reasons = await terminationOf(config);
        expect(reasons).toEqual([reasonText('configRefused', fixedDetail('Error'))]);
        for (const reason of reasons) expect(echoes(reason, value) || echoes(reason, MARKUP), reason).toBe(false);
    });

    it('every producer of a detail, given hostile input, gives none of it back', () => {
        for (const value of HOSTILE) {
            expect(errorName({ name: value })).toBe('Error');
            expect(errorName(Object.assign(new Error(value), { name: 'TypeError' }))).toBe('TypeError');
            expect(renamedModeNote(value)).toBe('');
        }
        expect(errorName(null)).toBe('null');
        expect(errorName('a string')).toBe('string');
        expect(refusalDetail(new Error(MARKUP))).toBe('');
        expect(refusalDetail(new OriginsTypeError('connect'))).toBe(': origins.connect is not a list');
        expect(joinDetails(fixedDetail('a'), fixedDetail('b'))).toBe('ab');
    });

    it('every templated reason, filled by each producer from hostile input, holds none of it', () => {
        const templated = (Object.keys(TERMINATION_REASONS) as ReasonId[]).filter(id => TERMINATION_REASONS[id].text.includes('…'));
        expect(templated.sort()).toEqual(['buildFailed', 'configRefused', 'unknownMode']);
        for (const id of templated) {
            for (const value of HOSTILE) {
                const details = [errorName({ name: value }), renamedModeNote(value), refusalDetail({ option: value })];
                for (const detail of details) {
                    const reason = reasonText(id as 'buildFailed', detail);
                    expect(echoes(reason, value), `${id}: ${reason}`).toBe(false);
                    expect(reason.startsWith(TERMINATION_REASONS[id].text.split('…')[0]!)).toBe(true);
                }
            }
        }
    });

    it('a plain string does not compile as a detail: only the producers make one', () => {
        const fromConfig: string = MARKUP;
        // @ts-expect-error a value of the configuration is a plain string, not a LibraryDetail
        expect(() => reasonText('buildFailed', fromConfig)).not.toThrow();
        // @ts-expect-error fixedDetail takes a literal only
        expect(fixedDetail(fromConfig)).toBe(MARKUP);
        // @ts-expect-error the entry's reason has no slot
        expect(reasonText('entryNotRegistered', fixedDetail('x'))).toBe(ENTRY_REASON);
    });

    it("the cast that brands a detail is in reasons.ts alone: no other source of the library's makes one", () => {
        const sources: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
                const file = `${dir}/${entry.name}`;
                if (entry.isDirectory()) walk(file);
                else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) sources.push(file);
            }
        };
        walk('src');
        const casting = sources.filter(file => /\bas LibraryDetail\b|<LibraryDetail>/.test(readFileSync(path.join(root, file), 'utf8')));
        expect(casting).toEqual(['src/lib/reasons.ts']);
        expect(readFileSync(path.join(root, 'src/lib/reasons.ts'), 'utf8').match(/\bas LibraryDetail\b/g)).toHaveLength(1);
    });
});
