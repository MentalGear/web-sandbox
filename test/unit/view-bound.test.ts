import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as view from '@src/lib/in-sandbox-view';
import { LOG_EVENTS_PER_SECOND } from '@src/lib/sandbox-log';
import { VIOLATION_EVENT_LIMIT } from '@src/lib/violation';
import { UNCAUGHT_CHARACTERS_PER_SECOND, UNCAUGHT_PER_SECOND } from '@src/lib/egress';
import { hostLine, reasonText } from '@src/lib/reasons';

/**
 * The view's cost bound (backlog S68): docs/API.md states it once, in "The view's cost to the host page", and
 * test/e2e/view-bound.spec.ts measures it. This keeps the statement and the code in step: every constant the section
 * names exists, and its table gives each one's value as the code has it. A constant renamed, removed or changed fails
 * here until the statement says so.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const HEADING = "## The view's cost to the host page";

function section(doc: string, heading: string): string {
    const lines = doc.split('\n');
    const start = lines.indexOf(heading);
    if (start < 0) throw new Error(`no heading "${heading}"`);
    const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
    return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

// Every constant the statement may name, from the code.
const CONSTANTS: Record<string, unknown> = {
    VIEW_APPLY_MS_PER_SECOND: view.VIEW_APPLY_MS_PER_SECOND,
    VIEW_MAX_OPERATION_MS: view.VIEW_MAX_OPERATION_MS,
    VIEW_OVERRUN_WINDOW_MS: view.VIEW_OVERRUN_WINDOW_MS,
    VIEW_URLS_PER_SECOND: view.VIEW_URLS_PER_SECOND,
    VIEW_MAX_URLS: view.VIEW_MAX_URLS,
    VIEW_MAX_DISTINCT_URLS: view.VIEW_MAX_DISTINCT_URLS,
    VIEW_MAX_ELEMENTS: view.VIEW_MAX_ELEMENTS,
    VIEW_MAX_DEPTH: view.VIEW_MAX_DEPTH,
    VIEW_MAX_CHARACTERS: view.VIEW_MAX_CHARACTERS,
    VIEW_RENDER_CHARACTERS_PER_SECOND: view.VIEW_RENDER_CHARACTERS_PER_SECOND,
    VIEW_RENDER_MAX_LENGTH: view.VIEW_RENDER_MAX_LENGTH,
    LOG_EVENTS_PER_SECOND,
    VIOLATION_EVENT_LIMIT,
    UNCAUGHT_PER_SECOND,
    UNCAUGHT_CHARACTERS_PER_SECOND,
};

const SECTION = section(read('docs/API.md'), HEADING);

// The rows of the section's constants table: | `NAME` | value | …
const rows = new Map([...SECTION.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| ([^|]+) \|/gm)].map(match => [match[1]!, match[2]!.trim()]));
// Every constant-like code span in the section, outside the table too.
const named = new Set([...SECTION.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map(match => match[1]!));

describe("docs/API.md, the view's cost to the host page", () => {
    it('names only constants that exist, and gives each a row of the table', () => {
        expect(named.size).toBeGreaterThan(0);
        for (const name of named) {
            expect(CONSTANTS, `${name} is named in the statement`).toHaveProperty(name);
            expect(rows.has(name), `${name} has a row in the statement's table`).toBe(true);
        }
    });

    it('gives each constant the value the code has', () => {
        expect(rows.size).toBe(Object.keys(CONSTANTS).length);
        for (const [name, cell] of rows) {
            expect(CONSTANTS, name).toHaveProperty(name);
            expect(Number(cell.replace(/[\s,]/g, '').replace(/\(.*$/, '')), name).toBe(CONSTANTS[name]);
        }
    });

    it('the e2e suite that measures it, the constants it uses, and its links exist', () => {
        const spec = read('test/e2e/view-bound.spec.ts');
        for (const name of ['VIEW_APPLY_MS_PER_SECOND', 'VIEW_MAX_OPERATION_MS', 'VIEW_OVERRUN_WINDOW_MS', 'VIEW_URLS_PER_SECOND', 'VIEW_MAX_URLS', 'VIEW_MAX_DISTINCT_URLS']) {
            expect(spec).toContain(name);
            expect(named.has(name)).toBe(true);
        }
        // README's limits and ADR-005 link the statement instead of restating it
        const anchor = 'API.md#the-views-cost-to-the-host-page';
        expect(read('README.md')).toContain(`docs/${anchor}`);
        expect(read('docs/ADR-005-strict-mode.md')).toContain(anchor);
    });

    // Backlog S72 (class P): the single-operation bound is the repeated-overrun rule; (b) states it in the words the host
    // gives, and API.md's reasons and host lines name them as the registry has them (src/lib/reasons.ts).
    it('(b) states the repeated-overrun rule, with the reason and the warn line the element gives', () => {
        const reason = reasonText('viewOverrun');
        const warning = hostLine('viewFirstOverrun');
        const b = SECTION.slice(SECTION.indexOf('### (b)'), SECTION.indexOf('### (c)')).replace(/\s+/g, ' ');
        expect(b).toContain(`(\`${reason}\`)`);
        expect(b).toContain('`VIEW_OVERRUN_WINDOW_MS`');
        expect(b).toContain('at most one stall past 2000 ms per 5 minutes beyond the first');
        const api = read('docs/API.md').replace(/\s+/g, ' ');
        expect(api).toContain(`| \`${reason}\` |`);
        expect(api).toContain(`\`${warning}\``);
        expect(api).not.toMatch(/`the view spent more than \d+ ms on one operation`/);
    });

    it('lists what is outside the bound as one closed list', () => {
        const outside = SECTION.slice(SECTION.indexOf('### (d)'));
        for (const item of ['`allowAnimations: true`', 'image decodes', 'font', 'filter', 'bidirectional', '250 000-character', 'Memory', '`:hover`', 'unhandled rejections']) {
            expect(outside, item).toContain(item);
        }
    });
});
