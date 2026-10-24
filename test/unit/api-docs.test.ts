import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as publicApi from '@src/index';
import { WebSandbox, VIEW_LIVENESS_TIMEOUT_MS } from '@src/host';
import { createBroker } from '@src/lib/rpc';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { FILE_ERROR_CODES, MAX_FILES, MAX_PATH_LENGTH, MAX_TOTAL_BYTES } from '@src/lib/files';
import { toFetchPolicy } from '@src/lib/fetch-bridge';
import { INERT_TYPES } from '@src/lib/guest-writes';
import { ORIGIN_KINDS } from '@src/lib/csp/origins';
import { KIND_DIRECTIVES } from '@src/lib/csp/csp-generator';
import { RENDER_ELEMENTS, RENDER_REMOVED_ELEMENTS, VIEW_APPLY_MS_PER_SECOND, VIEW_MAX_DISTINCT_URLS, VIEW_MAX_OPERATION_MS, VIEW_OVERRUN_WINDOW_MS, VIEW_EVENT_LIMITS, VIEW_EVENT_TYPES, VIEW_FILE_TYPES, VIEW_MAX_CHARACTERS, VIEW_MAX_DEPTH, VIEW_MAX_ELEMENTS, VIEW_RENDER_CHARACTERS_PER_SECOND, VIEW_STILL_STYLE, VIEW_TARGET_MAX_LENGTH, VIEW_MAX_URLS, VIEW_URLS_PER_SECOND } from '@src/lib/in-sandbox-view';
import { LOG_BYTES_PER_SECOND, LOG_MAX_BYTES } from '@src/lib/sandbox-log';
import { RPC_ERROR_CODES, RPC_LIBRARY_CODES, RPC_MAX_BYTES, RPC_MAX_INBOUND_BYTES } from '@src/lib/rpc';
import type { Complete, Holds } from '@src/lib/utils';
import { WORKER_GLOBALS } from '@src/lib/worker-globals';
import { UNCAUGHT_CHARACTERS_PER_SECOND, UNCAUGHT_PER_SECOND } from '@src/lib/egress';
import { ELEMENT_EVENTS } from '@src/lib/element-events';
import { scriptHashSource } from '@src/lib/csp/script-hash';
import { WRAPPER_STYLE } from '@src/lib/frame-documents';
import { CONFIG_SCHEMA } from '@src/lib/config-schema';
import { TERMINATION_REASONS, type ReasonId } from '@src/lib/reasons';
import { SyntaxKind, tokenize } from '../../scripts/js-tokens';
import { LIMITS, type LimitName, type LimitRow } from '@src/lib/limits';
import { OPEN_BACKLOG_ITEMS } from '../../docs/ids';

/**
 * docs/API.md is the consumer's reference (backlog D3): this test fails when the public surface and the
 * reference drift apart. Everything it compares is taken from the code — runtime exports, or the source text
 * where a fact only exists as a type or inside a stringified function — so a new option, method, event,
 * refusal code, guest global or limit fails here until it is documented, and a documented one that is gone
 * fails too. It checks names and numbers, not prose: what a row says is still the reviewer's to read.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const DOC = read('docs/API.md');

/**
 * The text under the first heading line that starts with `prefix`, up to the next heading of the same or a
 * higher level, or (own) up to the next heading of any level.
 */
function section(prefix: string, own = false): string {
    const lines = DOC.split('\n');
    const start = lines.findIndex(line => line.startsWith(prefix));
    if (start < 0) throw new Error(`docs/API.md has no heading starting with ${prefix}`);
    const level = lines[start]!.match(/^#+/)![0].length;
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        const heading = line.match(/^(#+) /);
        if (heading && (own || heading[1]!.length <= level)) break;
        body.push(line);
    }
    return body.join('\n');
}

/** `text` without its generated regions (tools/docgen): the tables the code renders, which have no interface to be compared with. */
const withoutRegions = (text: string) => text.replace(/^<!-- generated:begin [\w:.-]+ -->$[\s\S]*?^<!-- generated:end -->$/gm, '');

/** The first cells of the table rows in `text` that are one code span: | `name` | … */
function rowKeys(text: string): string[] {
    const keys: string[] = [];
    for (const match of text.matchAll(/^\| `([^`]+)` \|/gm)) keys.push(match[1]!);
    return keys;
}

/** The table row in `text` whose first cell starts with `label`. */
function row(text: string, label: string): string {
    const found = text.split('\n').find(line => line.startsWith(`| ${label}`));
    if (!found) throw new Error(`no row starting with "${label}"`);
    return found;
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
// The code spans of `text`, outside fenced code blocks (whose ``` fences would pair up with other backticks).
const spans = (text: string) => new Set([...text.replace(/^```[\s\S]*?^```/gm, '').matchAll(/`([^`\n]+)`/g)].map(match => match[1]!));

/**
 * The top-level member names of an exported interface, read from its source; of an exported object type or a union of
 * them (FetchRecord), every name any member has.
 */
function interfaceKeys(file: string, name: string): string[] {
    const source = read(file);
    const alias = source.indexOf(`export type ${name} = `);
    if (alias >= 0) return [...new Set([...source.slice(alias, source.indexOf('\n);', alias)).matchAll(/(?:^|[{;])\s*(\w+)\??:/gm)].map(match => match[1]!))];
    const start = source.search(new RegExp(`export interface ${name}(?: extends \\w+)? \\{`));
    if (start < 0) throw new Error(`${file} has no interface ${name}`);
    const body = source.slice(start, source.indexOf('\n}', start));
    const keys: string[] = [];
    for (const match of body.matchAll(/^ {4}(\w+)\??:/gm)) keys.push(match[1]!);
    return keys;
}

describe('docs/API.md lists the public surface', () => {
    it('every export of the package entry point', () => {
        const names: string[] = [];
        for (const block of read('src/index.ts').matchAll(/export (?:type )?\{([^}]+)\}/g)) {
            for (const name of block[1]!.split(',')) if (name.trim()) names.push(name.trim());
        }
        expect(names.length).toBeGreaterThan(20);
        const exportsSection = section('## Exports');
        for (const name of names) expect(exportsSection, name).toMatch(new RegExp(`\\b${name}\\b`));
        // and every value export is a real one
        for (const name of Object.keys(publicApi)) expect(names, name).toContain(name);
    });

    it('every numeric export of the package is a limit of the registry, with its value, and every exported limit is one', () => {
        const numeric = Object.entries(publicApi).filter(([, value]) => typeof value === 'number');
        expect(numeric.length).toBeGreaterThan(5);
        for (const [name, value] of numeric) {
            expect(Object.hasOwn(LIMITS, name), name).toBe(true);
            expect(LIMITS[name as LimitName].exported, name).toBe(true);
            expect(LIMITS[name as LimitName].value, name).toBe(value);
        }
        for (const name of (Object.keys(LIMITS) as LimitName[]).filter(key => LIMITS[key].exported)) expect(publicApi, name).toHaveProperty(name);
    });

    it('a limit held inside a stringified function has the registry\'s value there, and the fetch bounds are the ones toFetchPolicy applies', () => {
        for (const name of Object.keys(LIMITS) as LimitName[]) {
            const limit: LimitRow = LIMITS[name];
            if (!limit.mirror) continue;
            const [file, constant] = limit.mirror;
            const declared = read(file).match(new RegExp(`const ${constant}(?:: [^=]+)? = (\\d+);`));
            expect(declared, `${file}: ${constant}`).not.toBeNull();
            expect(Number(declared![1]), name).toBe(limit.value);
        }
        // one window's worth: the bootstrap derives its buffer from its mirror of LOG_EVENTS_PER_SECOND
        expect(read('src/lib/in-sandbox-script.ts')).toMatch(/const LOG_BUFFER_LIMIT = LOG_LINES_PER_SECOND;/);
        const defaults = toFetchPolicy({ allow: [] }, () => {})!;
        const bounds = toFetchPolicy({ allow: [], maxBytes: 1e15, timeoutMs: 1e15, maxConcurrent: 1e15 }, () => {})!;
        expect([defaults.maxBytes, defaults.timeoutMs, defaults.maxConcurrent]).toEqual([LIMITS.DEFAULT_MAX_BYTES.value, LIMITS.DEFAULT_FETCH_TIMEOUT_MS.value, LIMITS.DEFAULT_MAX_CONCURRENT.value]);
        expect([bounds.maxBytes, bounds.timeoutMs, bounds.maxConcurrent]).toEqual([LIMITS.MAX_MAX_BYTES.value, LIMITS.MAX_TIMEOUT_MS.value, LIMITS.MAX_MAX_CONCURRENT.value]);
    });

    it('every config option of the schema is one of the option interfaces, and no other', () => {
        const documented = (Object.keys(CONFIG_SCHEMA) as (keyof typeof CONFIG_SCHEMA)[]).filter(name => !('removed' in CONFIG_SCHEMA[name]));
        const keys = ['SandboxConfigOptions', 'CooperativeSandboxConfig', 'WorkerSandboxConfig', 'StrictSandboxConfig'].flatMap(name => interfaceKeys('src/host.ts', name));
        expect(sorted(documented)).toEqual(sorted(keys));
        expect(sorted(rowKeys(section('## Configuration', true)))).toEqual(sorted(keys));
    });

    it('the default mode, and the strict html warning, as the code has them', () => {
        const source = read('src/host.ts');
        const mode = CONFIG_SCHEMA.mode.default; // the config schema declares every default (S67)
        const options = section('## Configuration', true);
        expect(row(options, '`mode`').split(/(?<!\\)\|/)[3]!.trim()).toBe(`\`'${mode}'\``);
        const warning = source.match(/const STRICT_HTML_SCRIPT_WARNING = "\[Sandbox\] ([^;]+);/)![1]!;
        expect(row(options, '`html`')).toContain(`${warning};`);
    });

    it('every fetchBridge field, and no other, with the defaults and bounds the code applies', () => {
        const table = section('### `fetchBridge`');
        expect(sorted(rowKeys(table))).toEqual(sorted(interfaceKeys('src/lib/fetch-bridge.ts', 'FetchBridgeConfig')));
        const defaults = toFetchPolicy({ allow: [] }, () => {})!;
        const bounds = toFetchPolicy({ allow: [], maxBytes: 1e15, timeoutMs: 1e15, maxConcurrent: 1e15 }, () => {})!;
        for (const field of ['maxBytes', 'timeoutMs', 'maxConcurrent'] as const) {
            const line = row(table, `\`${field}\``);
            expect(line, field).toContain(`\`${defaults[field]}\``);
            expect(line, field).toContain(`\`${bounds[field]}\``);
        }
        const methods = row(table, '`methods`');
        for (const method of defaults.methods) expect(methods).toContain(`\`${method}\``);
        const headers = row(table, '`headers`');
        for (const header of defaults.headers) expect(headers).toContain(`\`${header}\``);
    });

    it('every origins kind with its directive', () => {
        const text = section('### `origins`');
        expect(sorted(rowKeys(text))).toEqual(sorted(ORIGIN_KINDS));
        for (const kind of ORIGIN_KINDS) expect(row(text, `\`${kind}\``), kind).toContain(`\`${KIND_DIRECTIVES[kind]}\``);
    });

    it('every public method of the element, and no other', () => {
        const isPrivate = new Set([...read('src/host.ts').matchAll(/^ {4}private (\w+)/gm)].map(match => match[1]!));
        const callbacks = new Set(['constructor', 'connectedCallback', 'disconnectedCallback', 'adoptedCallback', 'state']);
        const methods = Object.getOwnPropertyNames(WebSandbox.prototype).filter(name => !isPrivate.has(name) && !callbacks.has(name));
        const documented = [...section('## Methods').matchAll(/^### `(\w+)\(/gm)].map(match => match[1]!);
        expect(sorted(documented)).toEqual(sorted(methods));
        expect(rowKeys(section('## The element'))).toEqual(['state']);
    });

    it('every event the element dispatches, and no other', () => {
        // the one table of the element's events (element-events.ts), each dispatched by host.ts (test/unit/element-events.test.ts)
        const dispatched = Object.keys(ELEMENT_EVENTS);
        expect(sorted(rowKeys(section('## Events', true)))).toEqual(sorted(dispatched));
        for (const [event, { bubbles }] of Object.entries(ELEMENT_EVENTS)) expect(row(section('## Events', true), `\`${event}\``).split('|')[3]!.trim(), event).toBe(bubbles ? 'yes' : 'no');
    });

    it('every field of every event detail', () => {
        const details: [string, string, string][] = [
            ['### `sandbox-log`', 'src/lib/sandbox-log.ts', 'SandboxLog'],
            ['### `violation`', 'src/lib/violation.ts', 'SandboxViolation'],
            ['### `fetch`', 'src/lib/fetch-bridge.ts', 'FetchRecord'],
        ];
        // the host lines are a table of their own, in a region of the sandbox-log section
        const withoutHostLines = (text: string) => text.replace(/^<!-- generated:begin host-lines -->$[\s\S]*?^<!-- generated:end -->$/gm, '');
        for (const [heading, file, name] of details) {
            const text = withoutHostLines(section(heading));
            // FetchRecord is a union: its fields are told by outcome, in prose, each as a code span
            if (name === 'FetchRecord') for (const key of interfaceKeys(file, name)) expect(spans(text), key).toContain(key);
            else expect(sorted(rowKeys(text)), name).toEqual(sorted(interfaceKeys(file, name)));
        }
        const listFiles = section('### `listFiles()`');
        for (const key of interfaceKeys('src/lib/files.ts', 'FileInfo')) expect(listFiles, key).toMatch(new RegExp(`\\b${key}\\b`));
    });

    it('every inert type a commit takes without { code: true }, and no other', () => {
        const commit = section('### `commitGuestWrites(');
        const listed = [...spans(commit)].filter(span => /^[a-z]+\/[a-z0-9.+-]+$/.test(span));
        expect(sorted(listed)).toEqual(sorted(INERT_TYPES));
    });

    const STRING_KINDS = new Set([SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateHead, SyntaxKind.TemplateMiddle, SyntaxKind.TemplateTail]);
    it('the element writes no reason or host line of its own: every one comes from the registry', () => {
        for (const file of ['src/host.ts', 'src/lib/lifecycle.ts', 'src/lib/config-schema.ts']) {
            const source = read(file);
            // a reason written at the termination itself, as a literal or a template
            expect(source.match(/t: '(?:terminate|buildFailed)', reason: ['"`]/g), file).toBeNull();
            expect(source.match(/^const \w+_REASON = /gm), file).toBeNull();
            // and every host line through hostLine(): the notices of a termination, and the element's own lines
            expect([...source.matchAll(/(?:hostNotice|_dispatchHostLog)\((?:'\w+', )?([^)]*)\)/g)].map(match => match[1]!).filter(arg => !arg.includes(':') && !/^hostLine\(|^notice$/.test(arg)), file).toEqual([]);
            // nor a reason's text in a string of its own
            const strings = tokenize(source).filter(token => STRING_KINDS.has(token.kind)).map(token => token.text).join('\n');
            for (const id of Object.keys(TERMINATION_REASONS) as ReasonId[]) {
                const fixed = TERMINATION_REASONS[id].text.split('…')[0]!;
                if (fixed.length > 12) expect(strings, `${file}: ${id}`).not.toContain(fixed);
            }
        }
    });

    it('every call code, with who sets it', () => {
        const table = section('### Calls');
        const source = read('src/lib/rpc.ts');
        const codes: readonly string[] = RPC_ERROR_CODES;
        // local: what localRefusal() mints; reported: what the clamp of a response lets through (refusalFromResponse),
        // and HANDLER_ERROR, its fallback
        const notLocal = source.match(/Exclude<RpcErrorCode, ([^>]+)>/)![1]!.match(/'[A-Z_]+'/g)!.map(code => code.slice(1, -1));
        const reported = [...source.matchAll(/reportedCode === CODE\.([A-Z_]+) \? CODE\.\1/g)].map(match => match[1]!).concat('HANDLER_ERROR');
        expect(sorted(rowKeys(table))).toEqual(sorted(codes));
        for (const code of codes) {
            const setBy = row(table, `\`${code}\``).split('|')[2]!.trim();
            const local = !notLocal.includes(code);
            expect(setBy, code).toBe(local && reported.includes(code) ? 'local, reported' : local ? 'local' : 'reported');
        }
    });

    it('the code lists are complete by construction: a list that misses a member of its union does not compile', () => {
        // @ts-expect-error a list without 'B' (`bun run typecheck` fails if this line type-checks)
        type Missing = Holds<Complete<'A' | 'B', readonly ['A']>>;
        type Whole = Holds<Complete<'A' | 'B', readonly ['B', 'A']>>;
        const checked: [Missing?, Whole?] = [];
        expect(checked).toEqual([]);
        // the library codes are the fetch codes and the file codes, and nothing else
        expect(sorted(RPC_LIBRARY_CODES)).toEqual(sorted([...publicApi.FETCH_ERROR_CODES, ...FILE_ERROR_CODES]));
    });

    it('every fetch code and every files code', () => {
        expect(sorted(rowKeys(section('### `sandboxFetch()`')))).toEqual(sorted(publicApi.FETCH_ERROR_CODES));
        const fileCodes = [...FILE_ERROR_CODES, read('src/lib/in-sandbox-files.ts').match(/const notFound = \(\) => coded\('[^']*', '([A-Z_]+)'\)/)![1]!];
        expect(sorted(rowKeys(section('### Files')))).toEqual(sorted(fileCodes));
    });

    it('every guest global, and the globals removed before guest code', () => {
        const files = ['src/lib/in-sandbox-script.ts', 'src/lib/in-sandbox-files.ts', 'src/lib/in-sandbox-view.ts'];
        const installed: string[] = [];
        const removed: string[] = [];
        for (const file of files) {
            const source = read(file);
            // published with the captured defineProperty (R2:C-1): `publish('x', …)` or `defineOwn(g, 'x', { value: … })`,
            // but for the inert window.name, which is no global of the library's (the request gate replaces the platform's
            // fetch, XMLHttpRequest and WebSocket through replaceGlobal, and adds none)
            for (const match of source.matchAll(/(?:\bpublish\(|defineOwn\(g, )'([A-Za-z]\w*)', (?!\{ get:)/g)) installed.push(match[1]!);
            for (const match of source.matchAll(/remove\((?:g|\w+Statics), '(\w+)'\)/g)) removed.push(match[1]!);
            const peer = source.match(/PEER_CONNECTION_CONSTRUCTORS = \['(\w+)'/);
            if (peer) removed.push(peer[1]!);
        }
        const globals = section('## Guest globals', true);
        expect(sorted(rowKeys(globals))).toEqual(sorted(installed));
        for (const name of removed) expect(globals, name).toContain(name);
        // the worker's allowlist: where it lives, and the four listed globals that can make a request
        expect(globals).toContain('src/lib/worker-globals.ts');
        for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts']) {
            expect(WORKER_GLOBALS, name).toContain(name);
            expect(globals, name).toContain(`\`${name}\``);
        }
        for (const name of ['EventSource', 'FontFace', 'WebTransport', 'Worker']) {
            expect(WORKER_GLOBALS, name).not.toContain(name);
            expect(globals, name).toContain(`\`${name}\``);
        }
    });

    it('every member of bridge, sandboxFiles and sandboxView', () => {
        const internal = ['exposeReserved', 'handleMessage', 'rejectAllPending', 'terminationError'];
        const bridge = Object.keys(createBroker(() => {})).filter(name => !internal.includes(name));
        expect(sorted(rowKeys(section('### `bridge`')))).toEqual(sorted(bridge));

        const files = Object.keys(inSandboxFiles([]));
        delete (globalThis as any).sandboxFiles;
        expect(sorted(rowKeys(section('### `sandboxFiles`')))).toEqual(sorted(files));

        const view = read('src/lib/in-sandbox-view.ts').match(/defineOwn\(g, 'sandboxView', \{ value: freeze\(\{([^}]+)\}\)/)![1]!.split(',').map(name => name.trim());
        const viewSection = section('### `sandboxView`');
        expect(sorted(rowKeys(viewSection))).toEqual(sorted(view));
        const viewSpans = spans(viewSection);
        for (const type of VIEW_EVENT_TYPES) expect(viewSpans.has(type), type).toBe(true);
        for (const element of RENDER_REMOVED_ELEMENTS) expect(viewSpans.has(element), element).toBe(true);
        // the renderer's allowlist, every element of every namespace
        for (const element of [...RENDER_ELEMENTS.html, ...RENDER_ELEMENTS.svg, ...RENDER_ELEMENTS.mathml]) expect(viewSpans.has(element), element).toBe(true);
        expect(viewSection).toContain(`at most ${VIEW_MAX_ELEMENTS} elements, nested at most ${VIEW_MAX_DEPTH} deep`);
        expect(viewSection).toContain(`at most ${VIEW_MAX_CHARACTERS} characters`); // R1:R1-1
        expect(viewSection).toContain(`at most ${VIEW_RENDER_CHARACTERS_PER_SECOND} characters of markup`);
        expect(VIEW_FILE_TYPES.length).toBe(27); // a new type is a new line of prose in the section, too
        expect(viewSection.replace(/\s+/g, ' ')).toContain(`Strings are cut at ${VIEW_EVENT_LIMITS.maxString} characters, \`ids\` at ${VIEW_EVENT_LIMITS.maxIds} entries, \`form\` at ${VIEW_EVENT_LIMITS.maxFields} fields, and all strings of one detail together at ${VIEW_EVENT_LIMITS.maxTotal} characters (of one frame of events`);
    });

    it('the host page policy: the view bootstrap\'s hash through viewScriptHash(), the wrapper style\'s hash as the code computes it', () => {
        const policy = section('## Host page policy');
        expect(policy).toContain('`viewScriptHash()`');
        expect(policy).toContain(scriptHashSource(WRAPPER_STYLE));
        expect(policy).toContain(scriptHashSource(VIEW_STILL_STYLE)); // allowAnimations: false
        expect(policy).not.toContain('srcdoc;'); // the hash is not read out of the wrapper's document
    });

    it('describes the current design only: no history, and a backlog item only where it is open (a gap the page states)', () => {
        const withoutOpenItems = DOC.replace(/\(BACKLOG\.md#[a-z0-9-]+\)/g, '').replace(/\b[ST]\d{1,3}\b/g, id => (OPEN_BACKLOG_ITEMS.includes(id) ? '' : id));
        expect(withoutOpenItems).not.toMatch(/\b[BCDHST]\d{1,2}\b/);
        expect(withoutOpenItems).not.toMatch(/\b(previously|no longer|used to|backlog)\b/i);
    });
});
