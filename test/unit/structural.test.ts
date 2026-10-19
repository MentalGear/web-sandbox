import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from 'node:v8';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { bootstrapListeners } from '@src/lib/egress';
import { createBroker, type RpcSend } from '@src/lib/rpc';
import { createSizeOf } from '@src/lib/structured-size';
import { LOG_MAX_ARGS, LOG_MAX_BYTES, LOG_MAX_STRING, toLogDetail } from '@src/lib/sandbox-log';
import { toViolationDetail, VIOLATION_MAX_STRING } from '@src/lib/violation';
import { VIEW_OPTIONS } from '@src/lib/in-sandbox-view';
import { SyntaxKind, tokenize, type Token } from '../../scripts/js-tokens';

/**
 * Structural checks (backlog S61.3; research 18): the chokepoints that closed a class, each kept closed by a test that
 * enumerates its domain mechanically rather than by the cases a review found.
 *   - The RPC frame (class P; review round 3, C-1): a branded type that only the three builders mint, and a source scan
 *     that no other code casts to it (test/unit/review-round-3.test.ts keeps every 'RPC_REQ' and 'RPC_RES' literal of
 *     src/ in those builders, and every post of the broker on one of their frames).
 *   - Every string a frame carries out of a guest realm, or out of the view, is cut, checked or measured before it is
 *     posted (class E-cpu: "cut before posting"): a scan of every frame literal in every function the library
 *     stringifies into a realm, against one table of its fields, so a new field or a new frame is a missing row here.
 *   - The size measure (structured-size.ts; class P and G) against the real structuredClone, over fast-check's
 *     arbitrary values restricted to what clone accepts.
 *   - The console relay (in-sandbox-script.ts) against the measure and against the host's reading of a line
 *     (sandbox-log.ts, toLogDetail): a differential test of the two ends of one budget.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const sourceFiles = (directory: string): string[] => readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
});

/** The token range [open brace, close brace] of `function <name>`'s body: past its type parameters, parameters and return type. */
function bodyOf(tokens: Token[], name: string): [number, number] {
    const at = tokens.findIndex((token, i) => token.text === name && tokens[i - 1]?.kind === SyntaxKind.FunctionKeyword);
    if (at < 0) throw new Error(`no function ${name}`);
    const skip = (from: number, open: SyntaxKind, close: SyntaxKind): number => {
        let depth = 0;
        for (let i = from; i < tokens.length; i++) {
            if (tokens[i]!.kind === open) depth++;
            if (tokens[i]!.kind === close && --depth === 0) return i + 1;
        }
        throw new Error(`unbalanced in ${name}`);
    };
    let i = at + 1;
    if (tokens[i]!.kind === SyntaxKind.LessThanToken) i = skip(i, SyntaxKind.LessThanToken, SyntaxKind.GreaterThanToken);
    i = skip(i, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    if (tokens[i]!.kind === SyntaxKind.ColonToken && tokens[i + 1]!.kind === SyntaxKind.OpenBraceToken) i = skip(i + 1, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken);
    while (tokens[i]!.kind !== SyntaxKind.OpenBraceToken) i++;
    return [i, skip(i, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken) - 1];
}

describe('the RPC frame: a branded type only the builders mint (class P; review round 3, C-1)', () => {
    it('a broker posts an RpcFrame only: an object literal is refused by the type checker', () => {
        const posted: unknown[] = [];
        const send: RpcSend = (frame) => { posted.push(frame); };
        // @ts-expect-error a frame not made by a builder (`bun run typecheck` fails if this line type-checks)
        send({ type: 'RPC_RES', id: 1, ok: true, value: 1 });
        expect(posted).toHaveLength(1); // the brand is a type only: nothing changes at run time
    });

    it('the cast that mints the brand is in the three builders and nowhere else in src/', () => {
        const BUILDERS = ['requestFrame', 'resultFrame', 'refusalFrame'];
        const found: string[] = [];
        let minted = 0;
        for (const file of sourceFiles('src')) {
            const tokens = tokenize(read(file));
            const builders = file === path.join('src', 'lib', 'rpc.ts') ? BUILDERS.map(name => bodyOf(tokens, name)) : [];
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i]!.text !== 'RpcFrame' || tokens[i - 1]?.kind !== SyntaxKind.AsKeyword) continue;
                if (builders.some(([open, close]) => i > open && i < close)) minted++;
                else found.push(`${file}: as RpcFrame outside the builders`);
            }
            // nor a cast through unknown or any, or a type assertion in angle brackets, to it
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i]!.text === 'RpcFrame' && tokens[i - 1]?.kind === SyntaxKind.LessThanToken && tokens[i + 1]?.kind === SyntaxKind.GreaterThanToken) found.push(`${file}: <RpcFrame>`);
            }
        }
        expect(found).toEqual([]);
        expect(minted).toBe(3);
    });
});

/**
 * Every field of every frame literal (an object literal whose first property is `type`) in the functions the library
 * stringifies into a realm, with the expression it is given, and what bounds it if it can be a string the guest
 * chose. `bound` starts with one of:
 *   not a string   a number, a boolean, or nothing of the guest's
 *   constant       a string of the library's (a literal, a member of a closed set, a text built from constants and counts)
 *   cut            a string the guest chose, cut to a fixed length before it is posted
 *   checked        a string the guest chose, refused past a fixed length before anything is posted
 *   measured       a snapshot, measured whole against a byte budget before it is posted, its strings cut first
 */
const FRAME_FIELDS: readonly (readonly [type: string, field: string, expression: string, bound: string])[] = [
    // in-sandbox-script.ts, inSandboxScript: the guest's bootstrap, on the logic port (or the announcement)
    ['SANDBOX_PORT', 'type', "'SANDBOX_PORT'", 'constant'],
    ['VIOLATION', 'type', "'VIOLATION'", 'constant'],
    ['VIOLATION', 'directive', 'cutAt(read.effectiveDirective || read.violatedDirective, VIOLATION_MAX_STRING)', 'cut: at VIOLATION_MAX_STRING (2048), the browser\'s directive name; the host takes it only if it matches /^[a-z][a-z-]{0,63}$/ (violation.ts)'],
    ['VIOLATION', 'blockedURI', 'cutAt(read.blockedURI, VIOLATION_MAX_STRING)', 'cut: at VIOLATION_MAX_STRING (2048), the browser\'s report of a URL the guest chose; cut again on receipt (violation.ts), at most VIOLATION_EVENT_LIMIT per environment'],
    ['VIOLATION', 'sourceFile', 'cutAt(read.sourceFile, VIOLATION_MAX_STRING)', 'cut: as blockedURI'],
    ['VIOLATION', 'lineNumber', 'read.lineNumber', 'not a string: the browser\'s number (the host keeps a positive integer only)'],
    ['VIOLATION', 'columnNumber', 'read.columnNumber', 'not a string: as lineNumber'],
    ['RESIZE', 'type', "'RESIZE'", 'constant'],
    ['RESIZE', 'height', 'height', 'not a string: a measured height'],
    ['LOG', 'type', "'LOG'", 'constant'],
    ['LOG', 'level', 'level', 'constant: one of log, info, warn, error'],
    ['LOG', 'args', '[text]', 'constant: the relay\'s own warning, built from constants and counts (ownLine)'],
    ['LOG', 'own', 'true', 'not a string'],
    ['LOG', 'args', 'line', 'measured: safeArgs: at most LOG_MAX_ARGS, each string cut at LOG_MAX_STRING, the rest measured against LOG_MAX_BYTES'],
    ['LOG', 'level', "'info'", 'constant'],
    ['LOG', 'args', '[`${mode} Ready`]', 'constant: the mode is one of three'],
    ['UNCAUGHT_PAST_BUDGET', 'type', "'UNCAUGHT_PAST_BUDGET'", 'constant'],
    ['PONG', 'type', "'PONG'", 'constant'],
    ['PONG', 'n', 'n', 'not a string: checked to be a number'],
    ['WORKER_STARTED', 'type', "'WORKER_STARTED'", 'constant'],
    // worker-bootstrap.ts, workerBootstrap: worker mode's frame
    ['SANDBOX_PORT', 'refused', 'refused', 'constant: one of worker, trusted-types, failed'],
    ['INIT_PORT', 'type', "'INIT_PORT'", 'constant'],
    // in-sandbox-view.ts, inSandboxView: the strict view, to the host page (view port) or the worker (render port)
    ['VIOLATION', 'directive', 'name', 'cut: at options.violationMaxString (VIOLATION_MAX_STRING), the browser\'s directive name; checked on receipt as above'],
    ['VIOLATION', 'blockedURI', 'cutText(blockedURI, options.violationMaxString)', 'cut: at options.violationMaxString (VIOLATION_MAX_STRING), a URL of the guest\'s markup or CSS; cut again on receipt, at most VIOLATION_EVENT_LIMIT per directive'],
    ['VIOLATION', 'sourceFile', 'cutText(sourceFile, options.violationMaxString)', 'cut: as blockedURI'],
    ['VIOLATION', 'lineNumber', 'lineNumber', 'not a string: the browser\'s number'],
    ['VIOLATION', 'columnNumber', 'columnNumber', 'not a string: the browser\'s number'],
    ['VIEW_EVENT', 'type', "'VIEW_EVENT'", 'constant'],
    ['VIEW_EVENT', 'detail', 'detail', 'cut: every string of it through clamp, at most VIEW_EVENT_LIMITS.maxString each and maxTotal together; ids and form fields capped'],
    ['VIEW_FIRST_OVERRUN', 'type', "'VIEW_FIRST_OVERRUN'", 'constant'],
    ['VIEW_OVERRUN', 'type', "'VIEW_OVERRUN'", 'constant'],
    ['VIEW_ACK', 'type', "'VIEW_ACK'", 'constant'],
    ['VIEW_ACK', 'refused', 'refused', 'constant: names from a fixed list (VIEW_MAX_ELEMENTS …)'],
    ['RESIZE', 'height', 'height', 'not a string: a measured height'],
    ['VIEW_PONG', 'type', "'VIEW_PONG'", 'constant'],
    ['VIEW_PONG', 'n', 'm.n', 'not a string: checked to be a number'],
    ['VIEW_WRITTEN', 'type', "'VIEW_WRITTEN'", 'constant'],
    ['VIEW_WRITTEN', 'id', 'm.id', 'not a string: checked to be a number'],
    ['TRUSTED_TYPES_REFUSED', 'type', "'TRUSTED_TYPES_REFUSED'", 'constant'],
    ['VIEW_READY', 'type', "'VIEW_READY'", 'constant'],
    ['VIEW_READY', 'width', 'g.innerWidth', 'not a string: the view\'s own window'],
    ['VIEW_READY', 'height', 'g.innerHeight', 'not a string: the view\'s own window'],
    ['VIEW_READY', 'stillStyleRefused', 'true', 'not a string'],
    ['GUEST_TEXT_DROPPED', 'type', "'GUEST_TEXT_DROPPED'", 'constant'],
    ['(type)', 'type', 'type', 'constant: GUEST_ERROR or GUEST_UNCAUGHT'],
    ['(type)', 'message', 'cutText(text, options.guestText.maxLength)', 'cut: to guestText.maxLength (2048), at most LOG_EVENTS_PER_SECOND a second'],
    ['WORKER_REFUSED', 'type', "'WORKER_REFUSED'", 'constant'],
    ['INIT_WORKER', 'type', "'INIT_WORKER'", 'constant'],
    // in-sandbox-view.ts, inStrictWorker: the strict prelude, in the guest's worker, to the view (render port)
    ['VIEW_RENDER', 'type', "'VIEW_RENDER'", 'constant'],
    ['VIEW_RENDER', 'html', 'html', 'checked: at most VIEW_RENDER_MAX_LENGTH characters, else render() throws'],
    ['VIEW_RENDER', 'into', 'into: target', 'checked: an id of at most VIEW_TARGET_MAX_LENGTH characters, or null'],
    ['VIEW_TEXT', 'type', "'VIEW_TEXT'", 'constant'],
    ['VIEW_TEXT', 'into', 'into: id', 'checked: an id of at most VIEW_TARGET_MAX_LENGTH characters'],
    ['VIEW_TEXT', 'text', 'text: value', 'checked: at most VIEW_RENDER_MAX_LENGTH characters, else text() throws'],
    ['VIEW_SET', 'type', "'VIEW_SET'", 'constant'],
    ['VIEW_SET', 'id', 'id', 'checked: an id of at most VIEW_TARGET_MAX_LENGTH characters; its value field, set by key after the literal, at most VIEW_RENDER_MAX_LENGTH, else set() throws'],
    ['VIEW_LISTEN', 'type', "'VIEW_LISTEN'", 'constant'],
    ['VIEW_LISTEN', 'types', 'types', 'constant: members of VIEW_EVENT_TYPES'],
    ['VIEW_STARTED', 'type', "'VIEW_STARTED'", 'constant'],
    // rpc.ts, createBroker: the three builders (both sides)
    ['RPC_REQ', 'type', "'RPC_REQ'", 'constant'],
    ['RPC_REQ', 'id', 'id', 'not a string: the broker\'s own counter'],
    ['RPC_REQ', 'method', 'method', 'checked: at most MAX_NAME_LENGTH (256) characters, else INVALID_CALL and nothing is posted'],
    ['RPC_REQ', 'args', 'args', 'measured: the snapshot, and the whole frame, against RPC_MAX_BYTES before it is posted'],
    ['RPC_RES', 'type', "'RPC_RES'", 'constant'],
    ['RPC_RES', 'id', 'id', 'checked: a number, or a string of at most MAX_NAME_LENGTH characters (isId), else the request is dropped'],
    ['RPC_RES', 'ok', 'true', 'not a string'],
    ['RPC_RES', 'value', 'value', 'measured: the snapshot, and the whole frame, against RPC_MAX_BYTES before it is posted'],
    ['RPC_RES', 'ok', 'false', 'not a string'],
    ['RPC_RES', 'error', 'cutText(error)', 'cut: to MAX_TEXT_LENGTH (65536) by the builder'],
    ['RPC_RES', 'code', 'code', 'constant: one of the broker\'s CODE constants'],
];

// Every function the library stringifies into a realm, and where it is declared.
const STRINGIFIED: Record<string, string> = {
    inSandboxScript: 'src/lib/in-sandbox-script.ts',
    workerBootstrap: 'src/lib/worker-bootstrap.ts',
    inSandboxView: 'src/lib/in-sandbox-view.ts',
    inStrictWorker: 'src/lib/in-sandbox-view.ts',
    assertEntryScoped: 'src/lib/in-sandbox-view.ts',
    sanitizeRender: 'src/lib/in-sandbox-view.ts',
    viewBudget: 'src/lib/in-sandbox-view.ts',
    cssLoadBound: 'src/lib/in-sandbox-view.ts',
    createBroker: 'src/lib/rpc.ts',
    createSizeOf: 'src/lib/structured-size.ts',
    inSandboxFiles: 'src/lib/in-sandbox-files.ts',
    inSandboxMarkup: 'src/lib/in-sandbox-files.ts',
    inSandboxImportMap: 'src/lib/in-sandbox-files.ts',
    keepOnlyWorkerGlobals: 'src/lib/worker-globals.ts',
    removeWebAssembly: 'src/host.ts',
};

/** The frame literals in `name`'s body: [type, field, expression] for each property (a shorthand's expression is its name). */
function frameLiterals(file: string, name: string): [string, string, string][] {
    const text = read(file);
    const tokens = tokenize(text);
    const [open, close] = bodyOf(tokens, name);
    const OPEN = new Set([SyntaxKind.OpenBraceToken, SyntaxKind.OpenParenToken, SyntaxKind.OpenBracketToken, SyntaxKind.TemplateHead]);
    const CLOSE = new Set([SyntaxKind.CloseBraceToken, SyntaxKind.CloseParenToken, SyntaxKind.CloseBracketToken, SyntaxKind.TemplateTail]);
    const out: [string, string, string][] = [];
    for (let i = open + 1; i < close; i++) {
        if (tokens[i]!.kind !== SyntaxKind.OpenBraceToken || tokens[i + 1]?.text !== 'type') continue;
        const after = tokens[i + 2]!;
        let type: string;
        if (after.kind === SyntaxKind.ColonToken && tokens[i + 3]!.kind === SyntaxKind.StringLiteral) type = tokens[i + 3]!.text.slice(1, -1);
        else if (after.kind === SyntaxKind.CommaToken) type = '(type)';
        else continue;
        if (type !== '(type)' && !/^[A-Z][A-Z_]+$/.test(type)) continue; // a Blob's or an observer's options, not a frame
        let depth = 0;
        let start = i + 1;
        for (let j = i; j < tokens.length; j++) {
            const kind = tokens[j]!.kind;
            if (OPEN.has(kind)) depth++;
            if (CLOSE.has(kind)) depth--;
            if ((kind === SyntaxKind.CommaToken && depth === 1) || depth === 0) {
                if (start < j) {
                    const property = text.slice(tokens[start]!.start, tokens[j - 1]!.end).replace(/\s+/g, ' ');
                    const colon = tokens[start + 1]?.kind === SyntaxKind.ColonToken;
                    out.push([type, tokens[start]!.text, colon && tokens[start]!.text !== 'into' && tokens[start]!.text !== 'text' ? property.slice(property.indexOf(':') + 1).trim() : property]);
                }
                start = j + 1;
                if (depth === 0) break;
            }
        }
    }
    return out;
}

describe('every string a frame carries out of a guest realm or the view is cut, checked or measured before it is posted (class E-cpu)', () => {
    it('the scan covers every function the library stringifies into a realm', () => {
        const stringified = new Set<string>();
        for (const file of sourceFiles('src')) {
            for (const match of read(file).matchAll(/\b([a-zA-Z]+)\.toString\(\)/g)) if (match[1] !== 'fn' && match[1] !== 'prototype') stringified.add(match[1]!);
        }
        expect([...stringified].sort()).toEqual(Object.keys(STRINGIFIED).sort());
    });

    it('every field of every frame literal is a row of the table, with its bound, and every row is in the code', () => {
        const found = new Set<string>();
        for (const [name, file] of Object.entries(STRINGIFIED)) {
            for (const [type, field, expression] of frameLiterals(file, name)) found.add(`${type}.${field} = ${expression}`);
        }
        const listed = new Set(FRAME_FIELDS.map(([type, field, expression]) => `${type}.${field} = ${expression}`));
        expect([...found].filter(entry => !listed.has(entry)), 'a frame field the table does not list').toEqual([]);
        expect([...listed].filter(entry => !found.has(entry)), 'a row no frame has').toEqual([]);
        for (const [type, field, , bound] of FRAME_FIELDS) {
            // no other kind: a string posted as it is, bounded only on receipt, fails here (backlog S61.3: the violation
            // reports' strings were such rows until they were cut at the source)
            expect(bound, `${type}.${field}`).toMatch(/^(not a string|constant|cut|checked|measured)\b/);
        }
    });

    it('the bootstrap and the view cut a violation report\'s strings at the length the host keeps', () => {
        const bootstrap = read('src/lib/in-sandbox-script.ts');
        expect(Number(bootstrap.match(/const VIOLATION_MAX_STRING = (\d+);/)![1])).toBe(VIOLATION_MAX_STRING);
        expect(VIEW_OPTIONS.violationMaxString).toBe(VIOLATION_MAX_STRING);
        // and the host cuts them again on receipt, as defence in depth
        const detail = toViolationDetail({ directive: 'img-src', blockedURI: 'x'.repeat(5000), sourceFile: 'y'.repeat(5000) })!;
        expect([detail.blockedURI.length, detail.sourceFile!.length]).toEqual([VIOLATION_MAX_STRING, VIOLATION_MAX_STRING]);
    });
});

// ---- The measure against the real structuredClone

// fast-check's arbitrary values, with every kind structured clone accepts and the measure knows: boxed values, Maps,
// Sets, BigInts, Dates, typed arrays (and their buffers), sparse arrays, null-prototype objects (clone makes them plain).
const cloneable = fc.anything({
    maxDepth: 4,
    maxKeys: 8,
    withBoxedValues: true,
    withMap: true,
    withSet: true,
    withBigInt: true,
    withDate: true,
    withTypedArray: true,
    withSparseArray: true,
    withNullPrototype: true,
    withObjectString: true,
}).filter(value => { try { structuredClone(value); return true; } catch { return false; } });

describe('the size measure (structured-size.ts) against the real structuredClone', () => {
    const sizeOf = createSizeOf();

    it('a snapshot of any value clone accepts measures finite, the same as its own clone (what the other end measures), and never throws', () => {
        fc.assert(fc.property(cloneable, (value) => {
            const snapshot = structuredClone(value);
            const bytes = sizeOf(snapshot, Infinity);
            return Number.isFinite(bytes) && bytes > 0 && sizeOf(structuredClone(snapshot), Infinity) === bytes;
        }), { numRuns: 400 });
    });

    it('it measures at least what V8\'s structured serializer writes for the snapshot (node:v8, the engine clone runs on), less its header', () => {
        fc.assert(fc.property(cloneable, (value) => {
            const snapshot = structuredClone(value);
            // 16: the serializer's version header and one top-level tag, which a value of 8 (a double) does not count
            return serialize(snapshot).length <= sizeOf(snapshot, Infinity) + 16;
        }), { numRuns: 400, examples: [[1.5], [2n ** 100n], ['é'.repeat(100)], [new Uint8Array(1000).subarray(10, 20)], [[new Date(0), /x+/gimsuy]]] });
    });

    it('a limit only stops the walk early: past it, the measure says so; within it, the measure is the same', () => {
        fc.assert(fc.property(cloneable, fc.nat(4096), (value, limit) => {
            const snapshot = structuredClone(value);
            const whole = sizeOf(snapshot, Infinity);
            const limited = sizeOf(snapshot, limit);
            return whole > limit ? limited > limit : limited === whole;
        }), { numRuns: 400 });
    });

    it('the buffers it offers for transfer are the snapshot\'s ArrayBuffers, each once', () => {
        fc.assert(fc.property(cloneable, (value) => {
            const snapshot = structuredClone(value);
            const buffers: unknown[] = [];
            sizeOf(snapshot, Infinity, buffers);
            return new Set(buffers).size === buffers.length && buffers.every(buffer => Object.prototype.toString.call(buffer) === '[object ArrayBuffer]');
        }), { numRuns: 200 });
    });
});

// ---- The console relay against the measure, and against the host's reading of the line

describe("the console relay (in-sandbox-script.ts) against the measure and the host's reading of a line (sandbox-log.ts)", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        delete (globalThis as any).bridge;
    });

    // The bootstrap as the host builds it in strict mode, on a port whose postMessage structured-clones the frame (the
    // bootstrap captures MessagePort.prototype.postMessage when it is made).
    function relay() {
        class ClonePort {
            frames: any[] = [];
            postMessage(frame: unknown) { this.frames.push(structuredClone(frame)); }
            set onmessage(_handler: unknown) {}
        }
        vi.stubGlobal('MessagePort', ClonePort);
        const silent = new Proxy({}, { get: () => () => {} }) as Console;
        const comms = inSandboxScript(false, 'strict', silent, createBroker, { externalPort: true, listeners: bootstrapListeners('strict') }, createSizeOf);
        const port = new ClonePort();
        comms.attach(port as unknown as MessagePort);
        port.frames.length = 0;
        return { log: (args: unknown[]) => comms.log('log', args), lines: () => port.frames.filter(frame => frame.type === 'LOG') };
    }

    // What a guest logs: anything clone takes, and what it refuses or the measure does not know (errors, functions,
    // symbols), long strings, buffers of any size, and buffers that leave only a few bytes of the line's budget, where a
    // placeholder must still fit (the counterexample below).
    const argument = fc.oneof(
        { weight: 4, arbitrary: cloneable },
        { weight: 1, arbitrary: fc.integer({ min: 0, max: 3 * LOG_MAX_STRING }).map(n => 'x'.repeat(n)) },
        { weight: 1, arbitrary: fc.integer({ min: 0, max: 2 * LOG_MAX_BYTES }).map(n => new Uint8Array(n)) },
        { weight: 1, arbitrary: fc.integer({ min: 0, max: 600 }).map(n => new Uint8Array(LOG_MAX_BYTES - 16 - n)) },
        { weight: 1, arbitrary: fc.constantFrom<unknown>(new Error('e'), new TypeError('t'), () => 1, Symbol('s'), { nested: new RangeError('r') }) },
    );
    const sizeOf = createSizeOf();
    // The host's reading of a line (toLogDetail's rule): the index of each argument it drops past LOG_MAX_BYTES.
    const hostDrops = (args: unknown[]) => {
        const dropped: number[] = [];
        let left = LOG_MAX_BYTES;
        args.forEach((value, i) => {
            const bytes = sizeOf(value, left);
            if (bytes > left) dropped.push(i);
            else left -= bytes;
        });
        return dropped;
    };

    // Class P (backlog S61.3): the relay's placeholders are part of its budget by construction, so the line it posts never
    // exceeds LOG_MAX_BYTES as the host measures it, whatever is logged. The first example is the counterexample this test
    // found: with 50 bytes of the budget left, the relay wrote a placeholder of 118 bytes, and the host dropped it and
    // warned that the guest's line was too large.
    it('for any arguments, the line the relay posts is within LOG_MAX_BYTES as the host measures it: the host drops nothing', () => {
        fc.assert(fc.property(fc.array(argument, { maxLength: LOG_MAX_ARGS + 6 }), (args) => {
            const { log, lines } = relay();
            log(args);
            const posted = lines();
            if (posted.length !== 1) return false;
            const line = posted[0]!;
            if (line.args.length > LOG_MAX_ARGS || line.args.length > args.length) return false;
            if (line.args.some((value: unknown) => typeof value === 'string' && value.length > LOG_MAX_STRING)) return false;
            let bytes = 0;
            for (const value of line.args) bytes += sizeOf(value, Infinity);
            if (bytes > LOG_MAX_BYTES) return false;
            let dropped = false;
            const detail = toLogDetail(line, 'guest', () => { dropped = true; });
            return !dropped && hostDrops(line.args).length === 0 && detail.args.length === line.args.length;
        }), {
            numRuns: 150,
            examples: [
                [[new Uint8Array(LOG_MAX_BYTES - 16 - 50), new Uint8Array(1000)]],
                [[new Uint8Array(LOG_MAX_BYTES - 16 - 50), new Uint8Array(1000), new Error('e'), 'x', 1]],
                [Array.from({ length: LOG_MAX_ARGS }, () => new Uint8Array(LOG_MAX_BYTES / 32))],
            ],
        });
    });

    it('when even a placeholder does not fit, the line ends with one tail that says how many arguments it dropped', () => {
        const { log, lines } = relay();
        log([new Uint8Array(LOG_MAX_BYTES - 16 - 200), new Uint8Array(1000), 'lost', 7]);
        const line = lines()[0]!;
        expect(line.args).toHaveLength(2);
        expect(line.args[1]).toBe(`[Sandbox] 3 more argument(s) past the log line's byte budget (${LOG_MAX_BYTES})`);
        expect(hostDrops(line.args)).toEqual([]);
        // with room for it, an argument past the budget is still named by its placeholder
        const roomy = relay();
        roomy.log([new Uint8Array(LOG_MAX_BYTES / 2), new Uint8Array(LOG_MAX_BYTES), 'kept']);
        expect(roomy.lines()[0]!.args.slice(1)).toEqual([`[Uint8Array: past the log line's byte budget (${LOG_MAX_BYTES})]`, 'kept']);
    });
});
