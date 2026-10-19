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
import { CHANNELS, FRAMES, type FrameField, type FrameRoute, type FrameType } from '@src/lib/frames';
import { REALMS, scanned, STRINGIFIED } from '@src/lib/realms';

/**
 * Structural checks (backlog S61.3; research 18): the chokepoints that closed a class, each kept closed by a test that
 * enumerates its domain mechanically rather than by the cases a review found.
 *   - The RPC frame (class P; review round 3, C-1): a branded type that only the three builders mint, and a source scan
 *     that no other code casts to it (test/unit/review-round-3.test.ts keeps every 'RPC_REQ' and 'RPC_RES' literal of
 *     src/ in those builders, and every post of the broker on one of their frames).
 *   - The frame table and the realms registry (S76; src/lib/frames.ts, src/lib/realms.ts) against the code: every
 *     frame literal of src/ is a row, every row is posted and read, and the registry names every stringified function.
 *   - Every string a frame carries out of a guest realm, or out of the view, is cut, checked or measured before it is
 *     posted (class E-cpu: "cut before posting"): a scan of every frame literal in every function the library
 *     stringifies into a realm, against the frame table's fields and bounds, so a new field or a new frame is a missing
 *     row.
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
 * stringifies into a realm (src/lib/realms.ts, STRINGIFIED), with the expression it is given. What bounds each field is
 * its row's in the frame table (src/lib/frames.ts, FRAMES): this list pins the expression at each place a frame is
 * posted, so an edit that drops a cut, or a new field, fails here. `(type)` is a literal whose `type` is a variable,
 * typed in the source as a union of frame types.
 */
const SENT: readonly (readonly [type: string, field: string, expression: string])[] = [
    // in-sandbox-script.ts, inSandboxScript: the guest's bootstrap, on the logic port (or the announcement)
    ['SANDBOX_PORT', 'type', "'SANDBOX_PORT'"],
    ['VIOLATION', 'type', "'VIOLATION'"],
    ['VIOLATION', 'directive', 'cutAt(read.effectiveDirective || read.violatedDirective, VIOLATION_MAX_STRING)'],
    ['VIOLATION', 'blockedURI', 'cutAt(read.blockedURI, VIOLATION_MAX_STRING)'],
    ['VIOLATION', 'sourceFile', 'cutAt(read.sourceFile, VIOLATION_MAX_STRING)'],
    ['VIOLATION', 'lineNumber', 'read.lineNumber'],
    ['VIOLATION', 'columnNumber', 'read.columnNumber'],
    ['RESIZE', 'type', "'RESIZE'"],
    ['RESIZE', 'height', 'height'],
    ['LOG', 'type', "'LOG'"],
    ['LOG', 'level', 'level'],
    ['LOG', 'args', '[text]'],
    ['LOG', 'own', 'true'],
    ['LOG', 'args', 'line'],
    ['LOG', 'level', "'info'"],
    ['LOG', 'args', '[`${mode} Ready`]'],
    ['UNCAUGHT_PAST_BUDGET', 'type', "'UNCAUGHT_PAST_BUDGET'"],
    ['PONG', 'type', "'PONG'"],
    ['PONG', 'n', 'n'],
    ['WORKER_STARTED', 'type', "'WORKER_STARTED'"],
    // worker-bootstrap.ts, workerBootstrap: worker mode's frame
    ['SANDBOX_PORT', 'refused', 'refused'],
    ['INIT_PORT', 'type', "'INIT_PORT'"],
    // in-sandbox-view.ts, inSandboxView: the strict view, to the host page (view port) or the worker (render port)
    ['VIOLATION', 'directive', 'name'],
    ['VIOLATION', 'blockedURI', 'cutText(blockedURI, options.violationMaxString)'],
    ['VIOLATION', 'sourceFile', 'cutText(sourceFile, options.violationMaxString)'],
    ['VIOLATION', 'lineNumber', 'lineNumber'],
    ['VIOLATION', 'columnNumber', 'columnNumber'],
    ['VIEW_EVENT', 'type', "'VIEW_EVENT'"],
    ['VIEW_EVENT', 'detail', 'detail'],
    ['VIEW_FIRST_OVERRUN', 'type', "'VIEW_FIRST_OVERRUN'"],
    ['VIEW_OVERRUN', 'type', "'VIEW_OVERRUN'"],
    ['VIEW_ACK', 'type', "'VIEW_ACK'"],
    ['VIEW_ACK', 'refused', 'refused'],
    ['RESIZE', 'height', 'height'],
    ['VIEW_PONG', 'type', "'VIEW_PONG'"],
    ['VIEW_PONG', 'n', 'm.n'],
    ['VIEW_WRITTEN', 'type', "'VIEW_WRITTEN'"],
    ['VIEW_WRITTEN', 'id', 'm.id'],
    ['TRUSTED_TYPES_REFUSED', 'type', "'TRUSTED_TYPES_REFUSED'"],
    ['VIEW_READY', 'type', "'VIEW_READY'"],
    ['VIEW_READY', 'width', 'g.innerWidth'],
    ['VIEW_READY', 'height', 'g.innerHeight'],
    ['VIEW_READY', 'stillStyleRefused', 'true'],
    ['GUEST_TEXT_DROPPED', 'type', "'GUEST_TEXT_DROPPED'"],
    ['(type)', 'type', 'type'],
    ['(type)', 'message', 'cutText(text, options.guestText.maxLength)'],
    ['WORKER_REFUSED', 'type', "'WORKER_REFUSED'"],
    ['INIT_WORKER', 'type', "'INIT_WORKER'"],
    // in-sandbox-view.ts, inStrictWorker: the strict prelude, in the guest's worker, to the view (render port)
    ['VIEW_RENDER', 'type', "'VIEW_RENDER'"],
    ['VIEW_RENDER', 'html', 'html'],
    ['VIEW_RENDER', 'into', 'into: target'],
    ['VIEW_TEXT', 'type', "'VIEW_TEXT'"],
    ['VIEW_TEXT', 'into', 'into: id'],
    ['VIEW_TEXT', 'text', 'text: value'],
    ['VIEW_SET', 'type', "'VIEW_SET'"],
    ['VIEW_SET', 'id', 'id'],
    ['VIEW_LISTEN', 'type', "'VIEW_LISTEN'"],
    ['VIEW_LISTEN', 'types', 'types'],
    ['VIEW_STARTED', 'type', "'VIEW_STARTED'"],
    // rpc.ts, createBroker: the three builders (both sides)
    ['RPC_REQ', 'type', "'RPC_REQ'"],
    ['RPC_REQ', 'id', 'id'],
    ['RPC_REQ', 'method', 'method'],
    ['RPC_REQ', 'args', 'args'],
    ['RPC_RES', 'type', "'RPC_RES'"],
    ['RPC_RES', 'id', 'id'],
    ['RPC_RES', 'ok', 'true'],
    ['RPC_RES', 'value', 'value'],
    ['RPC_RES', 'ok', 'false'],
    ['RPC_RES', 'error', 'cutText(error)'],
    ['RPC_RES', 'code', 'code'],
];

const isFrameType = (type: string): type is FrameType => Object.hasOwn(FRAMES, type);

/** The frame types a `type` variable can hold where the literal at `at` uses it: the union in its nearest `type: 'A' | 'B'` annotation. */
function variableTypes(tokens: Token[], at: number): string[] {
    for (let i = at; i > 1; i--) {
        const parameter = tokens[i - 1]?.kind === SyntaxKind.OpenParenToken || tokens[i - 1]?.kind === SyntaxKind.CommaToken;
        if (!parameter || tokens[i]!.text !== 'type' || tokens[i + 1]?.kind !== SyntaxKind.ColonToken || tokens[i + 2]?.kind !== SyntaxKind.StringLiteral) continue;
        const types: string[] = [];
        for (let j = i + 2; tokens[j]?.kind === SyntaxKind.StringLiteral; j += 2) {
            types.push(tokens[j]!.text.slice(1, -1));
            if (tokens[j + 1]?.kind !== SyntaxKind.BarToken) break;
        }
        return types;
    }
    throw new Error('a `type` variable with no annotated union before it');
}

/** The frame literals in `name`'s body: [type, field, expression, frame types] for each property (a shorthand's expression is its name). */
function frameLiterals(file: string, name: string): [string, string, string, string[]][] {
    const text = read(file);
    const tokens = tokenize(text);
    const [open, close] = bodyOf(tokens, name);
    const OPEN = new Set([SyntaxKind.OpenBraceToken, SyntaxKind.OpenParenToken, SyntaxKind.OpenBracketToken, SyntaxKind.TemplateHead]);
    const CLOSE = new Set([SyntaxKind.CloseBraceToken, SyntaxKind.CloseParenToken, SyntaxKind.CloseBracketToken, SyntaxKind.TemplateTail]);
    const out: [string, string, string, string[]][] = [];
    for (let i = open + 1; i < close; i++) {
        if (tokens[i]!.kind !== SyntaxKind.OpenBraceToken || tokens[i + 1]?.text !== 'type') continue;
        const after = tokens[i + 2]!;
        let type: string;
        if (after.kind === SyntaxKind.ColonToken && tokens[i + 3]!.kind === SyntaxKind.StringLiteral) type = tokens[i + 3]!.text.slice(1, -1);
        else if (after.kind === SyntaxKind.CommaToken) type = '(type)';
        else continue;
        if (type !== '(type)' && !/^[A-Z][A-Z_]+$/.test(type)) continue; // a Blob's or an observer's options, not a frame
        const types = type === '(type)' ? variableTypes(tokens, i) : [type];
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
                    out.push([type, tokens[start]!.text, colon && tokens[start]!.text !== 'into' && tokens[start]!.text !== 'text' ? property.slice(property.indexOf(':') + 1).trim() : property, types]);
                }
                start = j + 1;
                if (depth === 0) break;
            }
        }
    }
    return out;
}

/**
 * Every frame literal in src/'s code (comments and strings aside), by where it stands: posted (`type: 'X'` in an object
 * literal or a type), compared (`.type === 'X'`, `type !== 'X'`), or a constant declared as a frame type
 * (`'X' satisfies FrameType`). "file: TYPE" for each.
 */
function frameLiteralsInSource(): { posted: Set<string>; compared: Set<string>; all: string[] } {
    const posted = new Set<string>();
    const compared = new Set<string>();
    const all: string[] = [];
    const COMPARE = new Set([SyntaxKind.EqualsEqualsEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken, SyntaxKind.EqualsEqualsToken, SyntaxKind.ExclamationEqualsToken]);
    for (const file of sourceFiles('src')) {
        const tokens = tokenize(read(file));
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]!;
            if (token.kind !== SyntaxKind.StringLiteral || !/^['"][A-Z][A-Z_]+['"]$/.test(token.text)) continue;
            const type = token.text.slice(1, -1);
            // walk back over a union of literals, `type: 'A' | 'B'`
            let first = i;
            while (tokens[first - 1]?.kind === SyntaxKind.BarToken && tokens[first - 2]?.kind === SyntaxKind.StringLiteral) first -= 2;
            const before = tokens[first - 1], named = tokens[first - 2];
            if (before?.kind === SyntaxKind.ColonToken && named?.text === 'type') posted.add(type);
            else if (before && COMPARE.has(before.kind) && named?.text === 'type') compared.add(type);
            else if (tokens[i + 1]?.kind === SyntaxKind.SatisfiesKeyword && tokens[i + 2]?.text === 'FrameType') compared.add(type);
            else continue;
            all.push(`${file}: ${type}`);
        }
    }
    return { posted, compared, all };
}

describe('the frame table (src/lib/frames.ts) and the realms registry (src/lib/realms.ts) against the code', () => {
    it('every frame literal in src/ is a row of FRAMES, and every row is posted somewhere and read somewhere', () => {
        const { posted, compared, all } = frameLiteralsInSource();
        expect(all.filter(entry => !isFrameType(entry.slice(entry.lastIndexOf(' ') + 1))), 'a frame type FRAMES does not declare').toEqual([]);
        expect(Object.keys(FRAMES).filter(type => !posted.has(type)), 'a row no code posts').toEqual([]);
        const readByType = (type: FrameType) => compared.has(type) !== ('receivedAs' in FRAMES[type]);
        expect((Object.keys(FRAMES) as FrameType[]).filter(type => !readByType(type)), 'a row no code reads by its type, or one that says it is told apart otherwise').toEqual([]);
    });

    it('every route is between realms that speak on its channel, and every channel has frames and two ends', () => {
        const wrong: string[] = [];
        for (const [type, row] of Object.entries(FRAMES)) {
            for (const route of row.routes) {
                for (const realm of [...route.from, ...route.to]) {
                    if (!(REALMS[realm].channels as readonly string[]).includes(route.channel)) wrong.push(`${type}: ${realm} is not on ${route.channel}`);
                }
            }
        }
        expect(wrong).toEqual([]);
        for (const channel of Object.keys(CHANNELS)) {
            expect(Object.values(FRAMES).some(row => row.routes.some(route => route.channel === channel)), channel).toBe(true);
            expect(Object.values(REALMS).filter(realm => (realm.channels as readonly string[]).includes(channel)).length, channel).toBeGreaterThanOrEqual(2);
        }
    });

    it('the registry names every function the library stringifies into a realm, and the module that declares it', () => {
        const stringified = new Set<string>();
        const builders = new Set<string>();
        for (const file of sourceFiles('src')) {
            const tokens = tokenize(read(file));
            for (let i = 2; i + 2 < tokens.length; i++) {
                if (tokens[i]!.text !== 'toString' || tokens[i - 1]!.kind !== SyntaxKind.DotToken || tokens[i + 1]!.kind !== SyntaxKind.OpenParenToken || tokens[i + 2]!.kind !== SyntaxKind.CloseParenToken) continue;
                const name = tokens[i - 2]!.text;
                if (name === 'fn' || name === 'prototype' || tokens[i - 2]!.kind !== SyntaxKind.Identifier) continue;
                stringified.add(name);
                builders.add(file.split(path.sep).join('/'));
            }
        }
        expect([...stringified].sort()).toEqual(Object.keys(STRINGIFIED).sort());
        for (const [name, row] of Object.entries(STRINGIFIED)) expect(() => bodyOf(tokenize(read(row.module)), name), name).not.toThrow();
        // the files that stringify are the realms' builders, and every realm a function runs in has one
        const declared = new Set(Object.values(REALMS).flatMap(realm => (realm.builder === null ? [] : [realm.builder.split(',')[0]!])));
        expect([...builders].sort()).toEqual([...declared].sort());
        for (const [name, row] of Object.entries(STRINGIFIED)) for (const realm of row.realms) expect(REALMS[realm].builder, `${name} in ${realm}`).not.toBeNull();
        // every scan applies to some function, and the capture scan only where guest code runs
        for (const scan of ['capture', 'readOnce', 'typeofRead'] as const) expect(scanned(scan).length, scan).toBeGreaterThan(0);
        for (const name of scanned('capture')) expect(STRINGIFIED[name].realms.some(realm => REALMS[realm].guestCode), name).toBe(true);
    });
});

describe('every string a frame carries out of a guest realm or the view is cut, checked or measured before it is posted (class E-cpu)', () => {
    it('every field of every frame literal the stringified code posts is a field of its FRAMES row, from a realm of its route, and every row of SENT is in the code', () => {
        const found = new Set<string>();
        const wrong: string[] = [];
        for (const [name, row] of Object.entries(STRINGIFIED)) {
            for (const [type, field, expression, types] of frameLiterals(row.module, name)) {
                found.add(`${type}.${field} = ${expression}`);
                for (const frame of types) {
                    if (!isFrameType(frame)) {
                        wrong.push(`${name}: ${frame} is no frame type`);
                        continue;
                    }
                    if (field !== 'type' && !Object.hasOwn(FRAMES[frame].fields, field)) wrong.push(`${name}: ${frame}.${field} is no field of its row`);
                    const from = FRAMES[frame].routes.flatMap(route => route.from as readonly string[]);
                    if (!row.realms.some(realm => from.includes(realm))) wrong.push(`${name}: ${frame} is posted from ${row.realms.join(', ')}, no realm of its routes`);
                }
            }
        }
        expect(wrong).toEqual([]);
        const listed = new Set(SENT.map(([type, field, expression]) => `${type}.${field} = ${expression}`));
        expect([...found].filter(entry => !listed.has(entry)), 'a frame field SENT does not list').toEqual([]);
        expect([...listed].filter(entry => !found.has(entry)), 'a row of SENT no frame has').toEqual([]);
    });

    it('every field a guest realm or the view posts has a bound of the five kinds: only a frame the host alone sends carries a value of the host\'s', () => {
        for (const [type, row] of Object.entries(FRAMES)) {
            const fromHostOnly = row.routes.every((route: FrameRoute) => route.from.every(realm => realm === 'host'));
            for (const [field, { bound }] of Object.entries(row.fields as Readonly<Record<string, FrameField>>)) {
                // no other kind: a string posted as it is, bounded only on receipt, has no kind here (S61)
                if (!fromHostOnly) expect(['not a string', 'constant', 'cut', 'checked', 'measured'], `${type}.${field}`).toContain(bound);
            }
        }
    });

    it('the bootstrap and the view cut a violation report\'s strings at the length the host keeps', () => {
        const bootstrap = read('src/lib/in-sandbox-script.ts');
        expect(Number(bootstrap.match(/const VIOLATION_MAX_STRING(?:: [^=]+)? = (\d+);/)![1])).toBe(VIOLATION_MAX_STRING);
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
