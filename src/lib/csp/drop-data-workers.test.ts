import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CSPDirectives } from '../../csp-directives';
import { dropDataWorkerSources } from './drop-data-workers';
import { assertWidensOnly, effectiveSources, LOAD_KIND_LIST } from './effective-directive';
import { addFileSources } from './file-sources';
import { dropSelfSources } from './drop-self';
import { dropEvalSources } from './drop-eval';
import { addEvalSource } from './effective-directive';

afterEach(() => { vi.restoreAllMocks(); });

describe('dropDataWorkerSources (broad review PD1): no worker load from data:', () => {
    it.each<[string, CSPDirectives, Record<string, string[]>]>([
        ['worker-src governs: data: leaves it', { 'worker-src': ['blob:', 'DATA:', 'https://w.example'] }, { 'worker-src': ['blob:', 'https://w.example'] }],
        ['child-src governs: worker-src is made from it without data:, child-src (frames) is left', { 'child-src': ['data:', 'https://c.example'] }, { 'child-src': ['data:', 'https://c.example'], 'worker-src': ['https://c.example'] }],
        ['script-src governs: worker-src is made from it, scripts keep data:', { 'script-src': ["'unsafe-inline'", 'data:'] }, { 'script-src': ["'unsafe-inline'", 'data:'], 'worker-src': ["'unsafe-inline'"] }],
        ['default-src governs: worker-src is made from it', { 'default-src': ['data:'] }, { 'default-src': ['data:'], 'worker-src': [] }],
    ])('%s', (_, policy, expected) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const warned = new Set<string>();
        expect(dropDataWorkerSources(policy, warned)).toEqual(expected);
        expect(dropDataWorkerSources(policy, warned)).toEqual(expected);
        expect(warn).toHaveBeenCalledTimes(1); // once per directive and instance
        expect(effectiveSources(expected as CSPDirectives, 'worker-src').has('data:')).toBe(false);
    });

    it('a policy whose workers do not admit data: is returned as it is, silently', () => {
        const warn = vi.spyOn(console, 'warn');
        for (const policy of [{}, { 'worker-src': ['blob:'] }, { 'img-src': ['data:'] }, { 'worker-src': ['blob:'], 'script-src': ['data:'] }] as CSPDirectives[]) {
            expect(dropDataWorkerSources(policy, new Set())).toEqual(policy);
        }
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('assertWidensOnly (broad review PA1): the postcondition of every policy step', () => {
    it('effectiveSources reads what decides each kind: eval only eval keywords, attributes only quoted sources', () => {
        const policy: CSPDirectives = { 'script-src': ["'unsafe-inline'", "'unsafe-eval'", 'blob:', "'NONE'"] };
        expect([...effectiveSources(policy, 'eval')]).toEqual(["'unsafe-eval'"]);
        expect([...effectiveSources(policy, 'script-src-attr')]).toEqual(["'unsafe-inline'"]);
        expect([...effectiveSources(policy, 'worker-src')]).toEqual(["'unsafe-inline'", 'blob:']);
        expect([...effectiveSources(policy, 'img-src')]).toEqual([]); // default-src absent: 'none'
    });

    it('throws when a step adds a source to a kind it does not name, and returns the policy otherwise', () => {
        const before: CSPDirectives = { 'script-src': ['https://a.example'] };
        const after: CSPDirectives = { 'script-src': ['https://a.example', 'blob:'] };
        expect(() => assertWidensOnly(before, after, ['script-src-elem'], 'test')).toThrow(/worker-src/);
        expect(assertWidensOnly(before, after, ['script-src-elem', 'worker-src'], 'test')).toBe(after);
        expect(assertWidensOnly(after, before, [], 'test')).toBe(before); // narrowing is always allowed
    });

    it('every step holds it over random policies (it would throw otherwise)', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let seed = 7;
        const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000);
        const NAMES = LOAD_KIND_LIST.filter(kind => kind !== 'eval' && kind !== 'prefetch-src').concat(['default-src', 'script-src', 'style-src', 'child-src'] as never[]);
        const TOKENS = ["'none'", "'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://a.example', 'blob:', 'data:', '*', "'sha256-AAAA'"];
        for (let run = 0; run < 300; run++) {
            const policy: Record<string, string[]> = {};
            for (const name of NAMES) {
                if (random() < 0.6) continue;
                policy[name] = Array.from({ length: Math.floor(random() * 3) }, () => TOKENS[Math.floor(random() * TOKENS.length)]!);
            }
            const p = policy as CSPDirectives;
            expect(() => {
                dropEvalSources(p, random() < 0.5, new Set());
                dropDataWorkerSources(p, new Set());
                addFileSources(p, ['text/javascript', 'text/css', 'image/png'].filter(() => random() < 0.5), new Set());
                addEvalSource(p);
                dropSelfSources(p, new Set());
            }, JSON.stringify(policy)).not.toThrow();
        }
    });
});
