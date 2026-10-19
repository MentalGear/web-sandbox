import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWebSandbox } from '@src/host';
import { ELEMENT_EVENTS, elementEvent, freezeDeep } from '@src/lib/element-events';
import { LOG_MAX_BYTES } from '@src/lib/sandbox-log';
import { createSizeOf } from '@src/lib/structured-size';

/**
 * The element's events (class D/L; review round 5, L-3): one table, one constructor that freezes every detail deeply,
 * and a source scan that no event is made anywhere else.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir: string): string[] {
    const files: string[] = [];
    for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) files.push(...sources(file));
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(file);
    }
    return files;
}

defineWebSandbox();

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('one constructor for every event the element dispatches', () => {
    it('the source: no `new CustomEvent` in src/ outside src/lib/element-events.ts, and every dispatch in host.ts takes an elementEvent()', () => {
        const offenders: string[] = [];
        for (const file of sources(path.join(ROOT, 'src'))) {
            const relative = path.relative(ROOT, file);
            const text = readFileSync(file, 'utf8');
            if (relative !== path.join('src', 'lib', 'element-events.ts') && /new\s+CustomEvent\s*[(<]/.test(text)) offenders.push(`${relative}: new CustomEvent`);
            for (const match of text.matchAll(/\.dispatchEvent\(([^)]{0,40})/g)) {
                if (!match[1]!.startsWith('elementEvent(')) offenders.push(`${relative}: dispatchEvent(${match[1]}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('every type of the table is dispatched by host.ts, and host.ts dispatches no other', () => {
        const host = readFileSync(path.join(ROOT, 'src/host.ts'), 'utf8');
        const dispatched = new Set([...host.matchAll(/elementEvent\('([\w-]+)'/g)].map(match => match[1]!));
        expect([...dispatched].sort()).toEqual(Object.keys(ELEMENT_EVENTS).sort());
    });

    it('a detail is frozen deeply: objects, arrays, Maps and Sets, through cycles; typed arrays keep their bytes writable, as they must', () => {
        const shared = { deep: [1, { deeper: true }] };
        const map = new Map<unknown, unknown>([[{ key: 1 }, { value: [2] }]]);
        const cyclic: Record<string, unknown> = { name: 'c' };
        cyclic.self = cyclic;
        const bytes = new Uint8Array([1, 2]);
        const detail = { list: [shared, shared], map, set: new Set([{ inSet: 1 }]), cyclic, bytes };
        const event = elementEvent('sandbox-log', detail);
        expect(event.detail).toBe(detail);
        const frozen = (value: unknown) => Object.isFrozen(value);
        expect([detail, detail.list, shared, shared.deep, shared.deep[1], map, [...map.keys()][0], [...map.values()][0], ([...map.values()][0] as any).value, detail.set, [...detail.set][0], cyclic].every(frozen)).toBe(true);
        bytes[0] = 9;
        expect(bytes[0]).toBe(9);
        expect(event.bubbles).toBe(true);
        expect(elementEvent('terminated', { reason: 'r' }).bubbles).toBe(false);
        expect(elementEvent('ready').detail).toBeNull();
    });

    it(`what it costs: freezing a guest's log line of ${LOG_MAX_BYTES} bytes made of the smallest objects`, () => {
        // the line with the most objects a guest can send: empty objects, the smallest the measure counts (about 34 bytes
        // each), as many as fit LOG_MAX_BYTES, which the element measures on receipt anyway; at most 4 MiB of lines a second
        const objects = () => [Array.from({ length: 30000 }, () => ({}))];
        const measure = createSizeOf();
        const time = (work: () => void) => {
            const started = performance.now();
            work();
            return performance.now() - started;
        };
        const sample = objects();
        const measured = time(() => measure(sample, LOG_MAX_BYTES));
        const line = objects();
        const frozen = time(() => freezeDeep(line));
        console.log(`MEASURED a log line of 30000 objects: the measure every line already takes on receipt ${measured.toFixed(1)} ms, freezeDeep ${frozen.toFixed(1)} ms`);
        expect(measure(line, Infinity)).toBeLessThanOrEqual(LOG_MAX_BYTES);
        expect(Object.isFrozen(line[0]![29999])).toBe(true);
    });
});

describe('the details the element dispatches are frozen, every one', () => {
    it('ready, terminated, fileschanged, sandbox-log, violation and fileswritten: a listener reads a frozen detail, deeply', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        const heard: Record<string, boolean> = {};
        const deeplyFrozen = (value: unknown): boolean => {
            if (value === null || typeof value !== 'object') return true;
            if (!Object.isFrozen(value)) return false;
            return Object.values(value).every(deeplyFrozen);
        };
        for (const type of Object.keys(ELEMENT_EVENTS)) el.addEventListener(type, (e: CustomEvent) => { heard[type] = deeplyFrozen(e.detail); });
        document.body.appendChild(el);
        el.registerFiles({ 'a.txt': 'a' });
        el.setConfig({ mode: 'strict', guestWrites: true });
        el._enterState('ready');
        el._dispatchLog({ level: 'log', args: [{ a: [{ b: 1 }] }] }, 'guest');
        el._dispatchViolation({ type: 'VIOLATION', directive: 'img-src', blockedURI: 'https://x.example/' }, 'view');
        await el._handleGuestWrite(el._guestWrites, { change: 'write', path: 'w.txt', entry: 'w' });
        el._dispatchFetch({ method: 'GET', url: 'https://x.example/', outcome: 'refused', bytes: 0, durationMs: 0 });
        el.terminate();
        expect(heard).toEqual({ 'ready': true, 'terminated': true, 'sandbox-log': true, 'violation': true, 'fetch': true, 'fileschanged': true, 'fileswritten': true });
    });
});
