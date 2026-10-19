import { describe, it, expect } from 'vitest';
import { createBroker } from '@src/lib/rpc';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { inSandboxFiles, inSandboxImportMap, inSandboxMarkup } from '@src/lib/in-sandbox-files';
import { workerBootstrap } from '@src/lib/worker-bootstrap';
import { keepOnlyWorkerGlobals } from '@src/lib/worker-globals';
import { repeatedReads } from './read-once-scan';

/**
 * Class G (docs/research/18_finding_classes/README.md; review round 5, N-6): in the code that runs in a guest realm, a
 * property of one value is read at most once per function (test/unit/read-once-scan.ts). Round 4's scan matched only
 * `typeof x.p … x.p` in one statement, and sandboxFetch read `init.method` twice in one expression, to test it and to use
 * it. Guest-supplied objects and events are read once each, by readOptions() and readEvent() (in-sandbox-script.ts).
 *
 * The scan counts every value; the values below are the library's own (its constants, its records, the host's frames,
 * its lists' lengths), each named with why it may be read again. A guest value is never one of them. The view's
 * functions (inSandboxView, inStrictWorker, sanitizeRender) are in-sandbox-view.ts's, scanned by round 4's statement
 * scan (test/unit/review-round-4.test.ts) until that file's own values are listed here.
 */

const LIBRARY_VALUES: Record<string, Record<string, string>> = {
    createBroker: {
        CODE: 'its own constants',
        unsupported: 'its own record of what the measure did not know',
        entry: 'its own pending-call record',
        ids: 'its own list',
    },
    inSandboxScript: {
        TRAVERSALS: 'its own constant list',
        times: 'its own list',
        tag: 'a string: what Object.prototype.toString answered',
        objects: 'its own list',
        depths: 'its own list',
        keys: 'its own list (Object.keys of a snapshot)',
        args: 'the rest parameter of its own wrapper',
        unsupported: 'its own record of what the measure did not know',
        line: 'its own list',
        held: 'its own list',
    },
    inSandboxFiles: {
        binary: 'a string the host wrote into the literal',
        target: 'its own record',
    },
    inSandboxImportMap: {
        map: 'its own import map, parsed from the host\'s literal',
    },
    inSandboxMarkup: {
        files: 'the sandboxFiles object it was handed',
    },
    keepOnlyWorkerGlobals: {
        descriptor: 'a descriptor the platform made, before any guest code runs',
        O: 'Object, before any guest code runs',
    },
};

describe('class G: a property of a guest value is read once per function', () => {
    const sources: [string, string][] = [
        ['createBroker', createBroker.toString()],
        ['inSandboxScript', inSandboxScript.toString()],
        ['inSandboxFiles', inSandboxFiles.toString()],
        ['inSandboxImportMap', inSandboxImportMap.toString()],
        ['inSandboxMarkup', inSandboxMarkup.toString()],
        ['workerBootstrap', workerBootstrap.toString()],
        ['keepOnlyWorkerGlobals', keepOnlyWorkerGlobals.toString()],
    ];

    for (const [name, source] of sources) {
        it(`${name}: every value read more than once is one of the library's own, and the list names no other`, () => {
            const allowed = LIBRARY_VALUES[name] ?? {};
            const repeated = repeatedReads(source);
            const offenders = repeated.filter(({ read }) => !Object.hasOwn(allowed, read.slice(0, read.indexOf('.'))));
            expect(offenders).toEqual([]);
            const used = new Set(repeated.map(({ read }) => read.slice(0, read.indexOf('.'))));
            expect(Object.keys(allowed).filter(value => !used.has(value))).toEqual([]);
        });
    }

    it('the scan finds what round 4\'s missed: a property read to test it and again to use it, in one function, in any statements', () => {
        const source = `function f(init) { const options = init || {}; const method = options.method === undefined ? 'GET' : String(options.method); return method; }`;
        expect(repeatedReads(source)).toEqual([{ read: 'options.method', count: 2 }]);
        const event = `function g(event) { if (!event.isTrusted) return; const a = event.message; queueMicrotask(() => event.message); }`;
        expect(repeatedReads(event)).toEqual([{ read: 'event.message', count: 2 }]);
        // once each, assignments, a nested function's own parameter of the same name, and a property of a property: none
        const clean = `function h(x) { const a = x.p; x.q = 1; const k = (x) => x.p; return a.p + x.r.p + x.r.q; }`;
        expect(repeatedReads(clean)).toEqual([{ read: 'x.r', count: 2 }]);
    });
});
