import { describe, it, expect } from 'vitest';
import { toViolationDetail, VIOLATION_EVENT_LIMIT } from './violation';

describe('toViolationDetail (backlog S5): a guest report is validated and clamped, never trusted', () => {
    it('keeps exactly the documented fields of a well-formed report, frozen', () => {
        const detail = toViolationDetail({
            type: 'VIOLATION', directive: 'img-src', blockedURI: 'https://attacker.test/x',
            sourceFile: 'about:srcdoc', lineNumber: 3, columnNumber: 7, extra: 'ignored', isHostFact: true,
        });
        expect(detail).toEqual({ directive: 'img-src', blockedURI: 'https://attacker.test/x', sourceFile: 'about:srcdoc', lineNumber: 3, columnNumber: 7 });
        expect(Object.isFrozen(detail)).toBe(true);
    });

    it('drops a frame without a well-formed directive name or a string blockedURI', () => {
        for (const frame of [
            null, undefined, 'VIOLATION', 42,
            { blockedURI: 'x' },
            { directive: 'IMG-SRC', blockedURI: 'x' },
            { directive: 'img-src; script-src *', blockedURI: 'x' },
            { directive: 'a'.repeat(65), blockedURI: 'x' },
            { directive: ['img-src'], blockedURI: 'x' },
            { directive: 'img-src' },
            { directive: 'img-src', blockedURI: { toString: () => 'x' } },
        ]) {
            expect(toViolationDetail(frame), JSON.stringify(frame)).toBeNull();
        }
    });

    it('clamps strings to 2048 characters and keeps an empty blockedURI', () => {
        const long = 'x'.repeat(5000);
        const detail = toViolationDetail({ directive: 'connect-src', blockedURI: long, sourceFile: long })!;
        expect(detail.blockedURI).toHaveLength(2048);
        expect(detail.sourceFile).toHaveLength(2048);
        expect(toViolationDetail({ directive: 'script-src-elem', blockedURI: '' })).toEqual({ directive: 'script-src-elem', blockedURI: '' });
    });

    it('leaves out a source position that is not a positive safe integer, and an empty or non-string sourceFile', () => {
        for (const bad of [0, -1, 1.5, NaN, Infinity, 2 ** 60, '3', null]) {
            expect(toViolationDetail({ directive: 'img-src', blockedURI: 'x', lineNumber: bad, columnNumber: bad })).toEqual({ directive: 'img-src', blockedURI: 'x' });
        }
        for (const bad of ['', 42, null, ['about:srcdoc']]) {
            expect(toViolationDetail({ directive: 'img-src', blockedURI: 'x', sourceFile: bad })).toEqual({ directive: 'img-src', blockedURI: 'x' });
        }
    });

    it('pins the per-environment cap', () => {
        expect(VIOLATION_EVENT_LIMIT).toBe(100);
    });
});
