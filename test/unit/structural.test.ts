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
import { BRIDGE_FRAME_SANDBOX } from '@src/lib/frame-documents';
import { BRIDGE_REQUEST_OPTIONS } from '@src/lib/in-bridge-frame';

/**
 * Structural checks (backlog S61.3; research 18): the chokepoints that closed a class, each kept closed by a test that
 * enumerates its domain mechanically rather than by the cases a review found.
 *   - The RPC frame (class P; R3:C-1): a branded type that only the three builders mint, and a source scan
 *     that no other code casts to it (test/unit/rpc-bounds-and-call-limits.test.ts keeps every 'RPC_REQ' and 'RPC_RES' literal of
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
    // the request gate's own reports (S74): the same frame, its strings cut the same way
    ['VIOLATION', 'directive', "'connect-src'"],
    ['VIOLATION', 'blockedURI', 'cutAt(reportedUrl(href), VIOLATION_MAX_STRING)'],
    ['VIOLATION', 'sourceFile', 'GATE_SOURCE'],
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
    // environment-check.ts, checkSandboxEnvironment: the first statement of every bootstrap that runs in a document
    ['ENVIRONMENT_REFUSED', 'type', "'ENVIRONMENT_REFUSED'"],
    ['ENVIRONMENT_REFUSED', 'refused', 'id'],
    // worker-bootstrap.ts, workerBootstrap: worker mode's frame
    ['SANDBOX_PORT', 'refused', 'refused'],
    ['INIT_PORT', 'type', "'INIT_PORT'"],
    // in-bridge-frame.ts, inBridgeFrame: the fetch bridge's frame, to the host page (bridge port)
    ['BRIDGE_READY', 'type', "'BRIDGE_READY'"],
    ['BRIDGE_HEAD', 'type', "'BRIDGE_HEAD'"],
    ['BRIDGE_HEAD', 'id', 'id'],
    ['BRIDGE_HEAD', 'responseType', 'response.type'],
    ['BRIDGE_HEAD', 'status', 'response.status'],
    ['BRIDGE_HEAD', 'statusText', 'statusText'],
    ['BRIDGE_HEAD', 'headers', 'pairs'],
    ['BRIDGE_HEAD', 'hasBody', 'stream !== null'],
    ['BRIDGE_CHUNK', 'type', "'BRIDGE_CHUNK'"],
    ['BRIDGE_CHUNK', 'id', 'id'],
    ['BRIDGE_CHUNK', 'chunk', 'chunk'],
    ['BRIDGE_END', 'type', "'BRIDGE_END'"],
    ['BRIDGE_END', 'id', 'id'],
    ['BRIDGE_ERROR', 'type', "'BRIDGE_ERROR'"],
    ['BRIDGE_ERROR', 'id', 'id'],
    ['BRIDGE_ERROR', 'code', 'code'],
    // in-sandbox-view.ts, inSandboxView: the strict view, to the host page (view port) or the worker (render port)
    ['VIOLATION', 'directive', 'name'],
    ['VIOLATION', 'blockedURI', 'cutText(blockedURI, options.violationMaxString)'],
    ['VIOLATION', 'sourceFile', 'cutText(sourceFile, options.violationMaxString)'],
    ['VIOLATION', 'lineNumber', 'lineNumber'],
    ['VIOLATION', 'columnNumber', 'columnNumber'],
    ['VIEW_EVENT', 'type', "'VIEW_EVENT'"],
    ['VIEW_EVENT', 'details', 'details'],
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
    ['VIEW_LISTEN', 'marks', 'marks'],
    ['VIEW_STARTED', 'type', "'VIEW_STARTED'"],
    ['VIEW_EVENT_ACK', 'type', "'VIEW_EVENT_ACK'"],
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

// What posts a frame in the stringified functions: the realms' own post helpers and `postMessage`.
const POSTERS = new Set(['post', 'send', 'toHost', 'postMessage']);
// What a poster may be given besides a frame literal: a frame already made and checked where it was minted (the
// chokepoint's own forwarding: the held outbox, the one post function's parameter), and the broker's three builders.
const FORWARDED = new Set(['frame', 'outbox', 'requestFrame', 'resultFrame', 'refusalFrame']);
// inSandboxFiles' `send` is `writeFiles`, a call of the guest's broker with a change record as its argument: not a frame.
const POSTS_NO_FRAMES = new Set(['inSandboxFiles']);

/**
 * The calls of a poster in `name`'s body (class E-cpu, BD1:TST-2): how many, and those whose first argument is not a
 * frame the table knows: an object literal whose first property is `type` and whose type is a string literal that is a
 * row of FRAMES (whatever its case or spelling), or a ternary of such literals, or a forwarded frame (FORWARDED).
 * A frame of any other shape (`{ kind: … }` in a variable, a type held in a variable, a lower-case or numbered type) is
 * listed, so it cannot be posted unseen by the field scan above, which reads only literals.
 */
function unreadablePosts(text: string, name: string): { posts: number; unreadable: string[] } {
    const tokens = tokenize(text);
    const [open, close] = bodyOf(tokens, name);
    const OPEN = new Set([SyntaxKind.OpenBraceToken, SyntaxKind.OpenParenToken, SyntaxKind.OpenBracketToken, SyntaxKind.TemplateHead]);
    const CLOSE = new Set([SyntaxKind.CloseBraceToken, SyntaxKind.CloseParenToken, SyntaxKind.CloseBracketToken, SyntaxKind.TemplateTail]);
    const known = (at: number): boolean => {
        const token = tokens[at];
        if (token?.kind === SyntaxKind.Identifier && FORWARDED.has(token.text)) return true;
        if (token?.kind !== SyntaxKind.OpenBraceToken || tokens[at + 1]?.text !== 'type') return false;
        const after = tokens[at + 2];
        if (after?.kind === SyntaxKind.ColonToken && tokens[at + 3]?.kind === SyntaxKind.StringLiteral) return isFrameType(tokens[at + 3]!.text.slice(1, -1));
        if (after?.kind !== SyntaxKind.CommaToken && after?.kind !== SyntaxKind.CloseBraceToken) return false;
        try { return variableTypes(tokens, at).every(isFrameType); } catch { return false; }
    };
    let posts = 0;
    const unreadable: string[] = [];
    for (let i = open + 1; i < close; i++) {
        const token = tokens[i]!;
        if (token.kind !== SyntaxKind.Identifier || !POSTERS.has(token.text) || tokens[i + 1]?.kind !== SyntaxKind.OpenParenToken || tokens[i - 1]?.kind === SyntaxKind.FunctionKeyword) continue;
        posts++;
        // the first argument: to the comma or the parenthesis that ends it; a ternary's branches start after its `?` and its `:`
        const branches = [i + 2];
        let depth = 0;
        let end = i + 2;
        for (; end < close; end++) {
            const kind = tokens[end]!.kind;
            if (OPEN.has(kind)) depth++;
            else if (CLOSE.has(kind)) { if (depth === 0) break; depth--; } else if (depth === 0 && kind === SyntaxKind.CommaToken) break;
            else if (depth === 0 && (kind === SyntaxKind.QuestionToken || kind === SyntaxKind.ColonToken)) branches.push(end + 1);
        }
        const argument = text.slice(tokens[i + 2]!.start, tokens[end - 1]!.end).replace(/\s+/g, ' ');
        // a plain argument is one branch; a ternary's condition is not a frame, only what follows `?` and `:`
        const frames = branches.length === 1 ? branches : branches.slice(1);
        if (!frames.every(known)) unreadable.push(`${token.text}(${argument.slice(0, 80)})`);
    }
    return { posts, unreadable };
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

// The global objects: a computed member of one (`globalThis['fe' + 'tch']`) names a global the scan cannot read.
const GLOBAL_OBJECTS = new Set(['globalThis', 'self', 'window']);
// The host-side modules of the bridge: no other request API is named there either, whatever the global it hangs on.
const HOST_BRIDGE_MODULES = new Set(['src/lib/fetch-bridge.ts', 'src/lib/bridge-frame.ts']);
const REQUEST_APIS = new Set(['sendBeacon', 'XMLHttpRequest', 'WebSocket', 'EventSource']);

/**
 * Where `text` (the source of `file`) names a way to make a request that the bridge's chokepoint does not own (class
 * E-net, BD1:ISO-1): the platform's `fetch` as a name, a read, a destructured alias (`const { fetch: x } = globalThis`)
 * or a call; a computed member of `globalThis`, `self` or `window`; `Reflect.get` and `getOwnPropertyDescriptor` of one;
 * and, in the bridge's host-side modules, `sendBeacon`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `new Image`,
 * `new Function`, `eval` and `import()`. The bodies in `allowed` (the two realm functions) may name `fetch` and are counted.
 */
function platformRequestUses(file: string, text: string, allowed: [number, number][]): { found: string[]; inRealms: number } {
    const tokens = tokenize(text);
    const found: string[] = [];
    let inRealms = 0;
    const inAllowed = (i: number) => allowed.some(([open, close]) => i > open && i < close);
    // the token after `globalThis` and the `as any)` or `)` of a cast around it
    const pastCast = (from: number): number => {
        let j = from;
        while (tokens[j]?.kind === SyntaxKind.AsKeyword) j += 2;
        if (j > from && tokens[j]?.kind === SyntaxKind.CloseParenToken) j++;
        return j;
    };
    // the closing brace of the braces that hold token `at`
    const closeOf = (at: number): number => {
        let depth = 0;
        for (let j = at; j < tokens.length; j++) {
            const kind = tokens[j]!.kind;
            if (kind === SyntaxKind.OpenBraceToken) depth++;
            if (kind === SyntaxKind.CloseBraceToken && depth-- === 0) return j;
        }
        return tokens.length - 1;
    };
    // whether the braces that end at `from - 1` are a pattern: `= …` follows, or a parameter's `): Type) =>`
    const bindsAPattern = (from: number): boolean => {
        const STOPS = new Set([SyntaxKind.SemicolonToken, SyntaxKind.CommaToken, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken, SyntaxKind.OpenParenToken, SyntaxKind.DotToken]);
        for (let j = from; j < Math.min(from + 8, tokens.length) && !STOPS.has(tokens[j]!.kind); j++) {
            if (tokens[j]!.kind === SyntaxKind.EqualsToken || tokens[j]!.kind === SyntaxKind.EqualsGreaterThanToken) return true;
        }
        return false;
    };
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.kind !== SyntaxKind.Identifier && token.kind !== SyntaxKind.ImportKeyword) continue;
        const before = tokens[i - 1]?.kind;
        const afterDot = before === SyntaxKind.DotToken || before === SyntaxKind.QuestionDotToken;
        const next = tokens[i + 1]?.kind;
        const say = (what: string) => found.push(`${file}: ${what} at ${token.start}`);
        if (token.text === 'fetch') {
            // A property key (`fetch: …` in a literal or a type) names no fetch; a read, a call, `x.fetch`, a shorthand
            // `{ fetch }` and a key of a destructuring pattern (`{ fetch: x } = …`, `({ fetch: x }) => …`) do.
            if (!afterDot && next === SyntaxKind.ColonToken) {
                if (!bindsAPattern(closeOf(i) + 1)) continue;
            }
            if (inAllowed(i)) inRealms++;
            else say('fetch');
            continue;
        }
        if (inAllowed(i)) continue;
        if (GLOBAL_OBJECTS.has(token.text) && !afterDot) {
            const j = pastCast(i + 1);
            if (tokens[j]?.kind === SyntaxKind.OpenBracketToken || (tokens[j]?.kind === SyntaxKind.QuestionDotToken && tokens[j + 1]?.kind === SyntaxKind.OpenBracketToken)) say(`computed member of ${token.text}`);
        }
        if (token.text === 'Reflect' && next === SyntaxKind.DotToken && ['get', 'getOwnPropertyDescriptor'].includes(tokens[i + 2]?.text ?? '') && tokens[i + 3]?.kind === SyntaxKind.OpenParenToken) say(`Reflect.${tokens[i + 2]!.text}`);
        if (token.text === 'getOwnPropertyDescriptor' && tokens[i + 1]?.kind === SyntaxKind.OpenParenToken && GLOBAL_OBJECTS.has(tokens[i + 2]?.text ?? '')) say('getOwnPropertyDescriptor of a global object');
        if (!HOST_BRIDGE_MODULES.has(file)) continue;
        if (REQUEST_APIS.has(token.text)) say(token.text);
        if (before === SyntaxKind.NewKeyword && (token.text === 'Image' || token.text === 'Function')) say(`new ${token.text}`);
        if (token.text === 'eval' && next === SyntaxKind.OpenParenToken) say('eval');
        if (token.kind === SyntaxKind.ImportKeyword && next === SyntaxKind.OpenParenToken) say('import()');
    }
    return { found: [...new Set(found)], inRealms };
}

describe("the fetch bridge's requests are made by its frame, and only there (BD1:ISO-1, class E-net)", () => {
    // The functions that may name the platform's fetch: the guest bootstrap, which guards the guest's own fetch
    // (keepalive), and the bridge's frame, which makes every bridge request. The host page's own realm makes no request
    // (not even to learn the page's policy: test/unit/host-policy-source.test.ts).
    const MAY_FETCH: readonly [string, string][] = [['src/lib/in-sandbox-script.ts', 'inSandboxScript'], ['src/lib/in-bridge-frame.ts', 'inBridgeFrame']];
    const unixOf = (file: string) => file.split(path.sep).join('/');

    it("no code of src/ names the platform's fetch outside those two functions, and the bridge's host-side modules name no other request API: the host never makes a bridge request itself", () => {
        const found: string[] = [];
        let inRealms = 0;
        for (const file of sourceFiles('src')) {
            const unix = unixOf(file);
            const text = read(file);
            const tokens = tokenize(text);
            const uses = platformRequestUses(unix, text, MAY_FETCH.filter(([module]) => module === unix).map(([, name]) => bodyOf(tokens, name)));
            found.push(...uses.found);
            inRealms += uses.inRealms;
        }
        expect(found).toEqual([]);
        expect(inRealms).toBeGreaterThanOrEqual(2); // positive control: the scan sees the two that do
    });

    it("and that scan flags each way a host request to the target could be spelled, in the bridge's host-side modules", () => {
        const file = 'src/lib/fetch-bridge.ts';
        const source = read(file);
        const anchor = "export const FETCH_METHOD = 'sandbox:fetch';";
        expect(source.split(anchor)).toHaveLength(2);
        const none: [number, number][] = [];
        expect(platformRequestUses(file, source, none).found).toEqual([]);
        const spellings: Record<string, string> = {
            'a property read': "void (globalThis as any).fetch;",
            'an alias at module scope, the name built from parts': "const early = (globalThis as any)['fe' + 'tch']?.bind(globalThis);",
            'a computed member in double quotes': 'void globalThis["fetch"];',
            'a computed member through self': "void self?.['fe' + 'tch'];",
            'a computed member of window': "void window['fetch'];",
            'a destructured alias': 'const { fetch: hostFetch } = globalThis as any;',
            'a destructured shorthand': 'const { fetch } = globalThis as any;',
            'a destructured parameter': 'void (({ fetch: f }: any) => f)(globalThis);',
            'Reflect.get': "void Reflect.get(globalThis, 'fetch');",
            'a property descriptor': "void Object.getOwnPropertyDescriptor(globalThis, 'fetch');",
            'sendBeacon': "void navigator.sendBeacon('https://a.example/', 'x');",
            'XMLHttpRequest': 'void new XMLHttpRequest();',
            'WebSocket': "void new WebSocket('wss://a.example/');",
            'EventSource': "void new EventSource('https://a.example/');",
            'an image': "void (new Image().src = 'https://a.example/');",
            'new Function': "void new Function('return 1');",
            'eval': "void eval('1');",
            'a dynamic import': "void import('https://a.example/x.js');",
        };
        for (const [spelling, mutant] of Object.entries(spellings)) {
            expect(platformRequestUses(file, source.replace(anchor, `${anchor}\n${mutant}`), none).found.length, spelling).toBeGreaterThan(0);
        }
        // a key of a literal or a type names nothing, and the other modules may name the request APIs the host-side ones may not
        expect(platformRequestUses(file, source.replace(anchor, `${anchor}\nconst table = { fetch: 1 }; type Events = { fetch: number };`), none).found).toEqual([]);
        expect(platformRequestUses('src/lib/limits.ts', 'void new WebSocket("wss://a.example/");', none).found).toEqual([]);
    });

    it("the bridge's one transport is its frame's, and the frame is built only by the frame builder, sandboxed to scripts alone", () => {
        const callers = (name: string) => sourceFiles('src')
            .filter(file => read(file).replace(`function ${name}(`, '').includes(`${name}(`))
            .map(unixOf);
        expect(callers('createFetchBridge')).toEqual(['src/host.ts']);
        expect(read('src/host.ts')).toMatch(/const frame = createBridgeFrame\(\{[^]*?\}\);\s*this\._bridgeFrame = frame;\s*this\._fetchBridge = createFetchBridge\(\{[^}]*transport: frame\.transport,/);
        expect(callers('createBridgeFrame')).toEqual(['src/host.ts']);
        expect(callers('buildBridgeDocument')).toEqual(['src/lib/bridge-frame.ts']);
        expect(BRIDGE_FRAME_SANDBOX).toBe('allow-scripts');
        expect(read('src/lib/bridge-frame.ts')).toContain("iframe.setAttribute('sandbox', BRIDGE_FRAME_SANDBOX);");
        // the frame's realm, its two channels and its frames are rows of the tables the docs are made from
        expect(REALMS['bridge-frame'].channels).toEqual(['announcement', 'bridge-init', 'bridge-port']);
        expect(Object.entries(FRAMES).filter(([, row]) => row.routes.some(route => route.channel === 'bridge-port')).map(([type]) => type).sort())
            .toEqual(['BRIDGE_ABORT', 'BRIDGE_CHUNK', 'BRIDGE_END', 'BRIDGE_ERROR', 'BRIDGE_FETCH', 'BRIDGE_HEAD', 'BRIDGE_PULL', 'BRIDGE_READY']);
    });

    it('the frame makes each request with the options the host checked it with, and nothing the host sent can change them', () => {
        expect(read('src/lib/in-bridge-frame.ts')).toContain('for (const name of Object.keys(pinned)) init[name] = pinned[name];');
        expect(read('src/lib/fetch-bridge.ts')).toContain('...BRIDGE_REQUEST_OPTIONS,');
        expect(BRIDGE_REQUEST_OPTIONS).toEqual({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual', mode: 'cors', cache: 'no-store', keepalive: false });
    });
});

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
        // and no function is stringified another way: interpolated whole, or through String()
        const names = Object.keys(STRINGIFIED).join('|');
        for (const file of sourceFiles('src')) expect(read(file).match(new RegExp(`\\$\\{(?:${names})\\}|String\\((?:${names})\\)`, 'g')), file).toBeNull();
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

    it('every frame the stringified code posts is a literal of a row of FRAMES, or a frame forwarded from where it was made (the scan of the fields above reads only literals)', () => {
        let posts = 0;
        const unreadable: string[] = [];
        for (const [name, row] of Object.entries(STRINGIFIED)) {
            if (POSTS_NO_FRAMES.has(name)) continue;
            const found = unreadablePosts(read(row.module), name);
            posts += found.posts;
            unreadable.push(...found.unreadable.map(call => `${name}: ${call}`));
        }
        expect(unreadable).toEqual([]);
        expect(posts, 'positive control: the scan finds the posts').toBeGreaterThan(35);
    });

    it('and the scan sees the shapes the field scan cannot: a lower-case or numbered type, a frame in a variable, a type from a variable', () => {
        const source = read('src/lib/in-sandbox-script.ts');
        const anchor = "post({ type: 'PONG', n });";
        expect(source.split(anchor)).toHaveLength(2); // the one place the mutants go in, a handler where `held` is in scope
        const mutants: Record<string, string> = {
            'a lower-case type': "post({ type: 'debug', payload: held });",
            'a type with a digit': "post({ type: 'LOG2', payload: held });",
            'a frame in a variable, `kind` for `type`': "const dbg = { kind: 'DEBUG', payload: held }; post(dbg);",
            'a type from a variable': "const t = 'DEBUG'; post({ type: t, payload: held });",
            'a frame that is built elsewhere': "post(make(held));",
            'a ternary with one unknown branch': "post(held ? { type: 'PONG', n } : { type: 'pong', n });",
        };
        const clean = unreadablePosts(source, 'inSandboxScript');
        expect(clean.unreadable).toEqual([]);
        for (const [shape, mutant] of Object.entries(mutants)) {
            const found = unreadablePosts(source.replace(anchor, `${anchor} ${mutant}`), 'inSandboxScript');
            expect(found.unreadable.length, shape).toBeGreaterThan(0);
        }
        // and a frame of a known type, written in the usual way, is not reported
        expect(unreadablePosts(source.replace(anchor, `${anchor} post({ type: 'PONG', n: 1 }); post(held ? { type: 'PONG', n } : { type: 'LOG', level: 'info', args: [] });`), 'inSandboxScript').unreadable).toEqual([]);
    });

    it("the bridge's frame is inside the same scan from both ends: the frame's posts (inBridgeFrame, stringified) and the host's posts to it (createBridgeFrame)", () => {
        const ENDS: [string, string, string][] = [
            ['src/lib/in-bridge-frame.ts', 'inBridgeFrame', "post({ type: 'BRIDGE_READY' }, []);"],
            ['src/lib/bridge-frame.ts', 'createBridgeFrame', "target.postMessage({ type: 'BRIDGE_INIT', maxBytes: setup.maxBytes }, '*', [channel.port2]);"],
        ];
        const mutants: Record<string, string> = {
            'a lower-case type': "post({ type: 'debug', payload: String(id) }, []);",
            'a frame with no type': "post({ kind: 'DEBUG', payload: String(id) }, []);",
            'a frame in a variable': "const dbg = { type: 'BRIDGE_END', id }; post(dbg, []);",
            'a type from a variable': "const t = 'DEBUG'; post({ type: t, id }, []);",
        };
        for (const [file, name, anchor] of ENDS) {
            const source = read(file);
            expect(source.split(anchor), file).toHaveLength(2);
            const clean = unreadablePosts(source, name);
            expect(clean.unreadable, file).toEqual([]);
            expect(clean.posts, `${file}: positive control`).toBeGreaterThanOrEqual(2);
            for (const [shape, mutant] of Object.entries(mutants)) {
                // the host's poster is `postMessage`: the same shapes, posted through it
                const text = name === 'createBridgeFrame' ? mutant.replace(/\bpost\(/g, 'port.postMessage(') : mutant;
                expect(unreadablePosts(source.replace(anchor, `${anchor} ${text}`), name).unreadable.length, `${file}: ${shape}`).toBeGreaterThan(0);
            }
        }
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
