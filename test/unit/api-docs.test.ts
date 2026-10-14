import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as publicApi from '@src/index';
import { WebSandbox, VIEW_LIVENESS_TIMEOUT_MS } from '@src/host';
import { createBroker } from '@src/lib/rpc';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { MAX_FILES, MAX_PATH_LENGTH, MAX_TOTAL_BYTES } from '@src/lib/files';
import { toFetchPolicy } from '@src/lib/fetch-bridge';
import { INERT_TYPES } from '@src/lib/guest-writes';
import { KNOWN_DIRECTIVES } from '@src/lib/csp/policy-grammar';
import { META_IGNORED_DIRECTIVES } from '@src/lib/csp/drop-meta-ignored';
import { STRICT_FIXED, STRICT_PASSED_THROUGH } from '@src/lib/csp/strict-policy';
import { RENDER_REMOVED_ELEMENTS, VIEW_EVENT_LIMITS, VIEW_EVENT_TYPES, VIEW_TARGET_MAX_LENGTH } from '@src/lib/in-sandbox-view';

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

/** The top-level member names of an exported interface, read from its source. */
function interfaceKeys(file: string, name: string): string[] {
    const source = read(file);
    const start = source.indexOf(`export interface ${name} {`);
    if (start < 0) throw new Error(`${file} has no interface ${name}`);
    const body = source.slice(start, source.indexOf('\n}', start));
    const keys: string[] = [];
    for (const match of body.matchAll(/^ {4}(\w+)\??:/gm)) keys.push(match[1]!);
    return keys;
}

/** The members of a string-literal union type, read from its source. */
function unionMembers(file: string, name: string): string[] {
    const source = read(file);
    const declaration = source.match(new RegExp(`export type ${name} =([^;]+);`));
    if (!declaration) throw new Error(`${file} has no union ${name}`);
    return [...declaration[1]!.matchAll(/'([A-Z_]+)'/g)].map(match => match[1]!);
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

    it('every numeric export, with its value, in Limits', () => {
        const limits = section('## Limits');
        const numeric = Object.entries(publicApi).filter(([, value]) => typeof value === 'number');
        expect(numeric.length).toBeGreaterThan(5);
        for (const [name, value] of numeric) {
            const line = limits.split('\n').find(candidate => candidate.includes(`\`${name}\``));
            expect(line, name).toBeDefined();
            expect(line!.split('|')[2]!.trim().split(' ')[0], name).toBe(String(value));
        }
    });

    it('the internal limits, with their values', () => {
        const limits = section('## Limits');
        const fetchDefaults = toFetchPolicy({ allow: [] }, () => {})!;
        const fetchBounds = toFetchPolicy({ allow: [], maxBytes: 1e15, timeoutMs: 1e15, maxConcurrent: 1e15 }, () => {})!;
        const rpcDefault = Number(read('src/lib/rpc.ts').match(/const DEFAULT_TIMEOUT_MS = (\d+);/)![1]);
        const expected: [string, number][] = [
            ['Default call timeout', rpcDefault],
            ['Strict: characters of a render or event target id', VIEW_TARGET_MAX_LENGTH],
            ['Strict: view liveness budget', VIEW_LIVENESS_TIMEOUT_MS],
            ['Files: total bytes', MAX_TOTAL_BYTES],
            ['Files: count', MAX_FILES],
            ['Files: path length', MAX_PATH_LENGTH],
            ['Fetch: default `maxBytes`', fetchDefaults.maxBytes],
            ['Fetch: largest `maxBytes`', fetchBounds.maxBytes],
            ['Fetch: default `timeoutMs`', fetchDefaults.timeoutMs],
            ['Fetch: largest `timeoutMs`', fetchBounds.timeoutMs],
            ['Fetch: default `maxConcurrent`', fetchDefaults.maxConcurrent],
            ['Fetch: largest `maxConcurrent`', fetchBounds.maxConcurrent],
        ];
        for (const [label, value] of expected) {
            expect(row(limits, label).split('|')[2]!.trim().split(' ')[0], label).toBe(String(value));
        }
    });

    it('every config option, and no other', () => {
        const options = section('## Configuration', true);
        expect(sorted(rowKeys(options))).toEqual(sorted(interfaceKeys('src/host.ts', 'SandboxConfig')));
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

    it('every CSP directive name, the strict subset and the ignored ones', () => {
        const policy = spans(section('### `connectionsAllowed`'));
        const names = [...KNOWN_DIRECTIVES, ...META_IGNORED_DIRECTIVES, ...STRICT_FIXED, ...STRICT_PASSED_THROUGH];
        for (const name of names) expect(policy.has(name), name).toBe(true);
    });

    it('every capability', () => {
        const options = spans(section('## Configuration', true));
        for (const capability of [...publicApi.SAFE_CAPABILITIES, ...publicApi.UNSAFE_CAPABILITIES]) {
            expect(options.has(capability), capability).toBe(true);
        }
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
        const dispatched = [...read('src/host.ts').matchAll(/new CustomEvent\('([\w-]+)'/g)].map(match => match[1]!);
        expect(sorted(rowKeys(section('## Events', true)))).toEqual(sorted(dispatched));
    });

    it('every field of every event detail', () => {
        const details: [string, string, string][] = [
            ['### `sandbox-log`', 'src/lib/sandbox-log.ts', 'SandboxLog'],
            ['### `violation`', 'src/lib/violation.ts', 'SandboxViolation'],
            ['### `fetch`', 'src/lib/fetch-bridge.ts', 'FetchRecord'],
        ];
        for (const [heading, file, name] of details) {
            expect(sorted(rowKeys(section(heading))), name).toEqual(sorted(interfaceKeys(file, name)));
        }
        const listFiles = section('### `listFiles()`');
        for (const key of interfaceKeys('src/lib/files.ts', 'FileInfo')) expect(listFiles, key).toMatch(new RegExp(`\\b${key}\\b`));
    });

    it('every inert type a commit takes without { code: true }, and no other', () => {
        const commit = section('### `commitGuestWrites(');
        const listed = [...spans(commit)].filter(span => /^[a-z]+\/[a-z0-9.+-]+$/.test(span));
        expect(sorted(listed)).toEqual(sorted(INERT_TYPES));
    });

    it('every termination reason', () => {
        const source = read('src/host.ts');
        const reasons = section('### `terminated` reasons');
        const constants = [...source.matchAll(/^const \w+_REASON = '([^']+)';/gm)].map(match => match[1]!);
        const literals = [...source.matchAll(/this\._terminate\(['`]([^'`]+)['`]\)/g)].map(match => match[1]!);
        expect(constants.length).toBeGreaterThan(3);
        for (const reason of [...constants, ...literals]) {
            const fixedPart = reason.split('${')[0]!.replace(/\s*"?$/, '');
            expect(reasons, reason).toContain(fixedPart);
        }
    });

    it('every call code, with who sets it', () => {
        const table = section('### Calls');
        const codes = unionMembers('src/lib/rpc.ts', 'RpcErrorCode');
        const reported = read('src/lib/rpc.ts').match(/Exclude<RpcErrorCode, ([^>]+)>/)![1]!.match(/'[A-Z_]+'/g)!.map(code => code.slice(1, -1));
        expect(sorted(rowKeys(table))).toEqual(sorted(codes));
        for (const code of codes) {
            const setBy = row(table, `\`${code}\``).split('|')[2]!.trim();
            expect(setBy, code).toBe(reported.includes(code) ? 'reported' : 'local');
        }
    });

    it('every fetch code and every files code', () => {
        expect(sorted(rowKeys(section('### `sandboxFetch()`')))).toEqual(sorted(publicApi.FETCH_ERROR_CODES));
        const fileCodes = [...unionMembers('src/lib/files.ts', 'FileErrorCode'), read('src/lib/in-sandbox-files.ts').match(/error\.code = '([A-Z_]+)'/)![1]!];
        expect(sorted(rowKeys(section('### Files')))).toEqual(sorted(fileCodes));
    });

    it('every guest global, and the globals removed before guest code', () => {
        const files = ['src/lib/in-sandbox-script.ts', 'src/lib/in-sandbox-files.ts', 'src/lib/in-sandbox-view.ts'];
        const installed: string[] = [];
        const removed: string[] = [];
        for (const file of files) {
            const source = read(file);
            for (const match of source.matchAll(/(?:\(globalThis as any\)|\bg)\.([A-Za-z]\w*) = /g)) installed.push(match[1]!);
            for (const match of source.matchAll(/remove\(g(?:\.\w+)?, '(\w+)'\)/g)) removed.push(match[1]!);
            const peer = source.match(/PEER_CONNECTION_CONSTRUCTORS = \['(\w+)'/);
            if (peer) removed.push(peer[1]!);
        }
        const globals = section('## Guest globals', true);
        expect(sorted(rowKeys(globals))).toEqual(sorted(installed));
        for (const name of removed) expect(globals, name).toContain(name);
    });

    it('every member of bridge, sandboxFiles and sandboxView', () => {
        const internal = ['exposeReserved', 'handleMessage', 'rejectAllPending', 'terminationError'];
        const bridge = Object.keys(createBroker(() => {})).filter(name => !internal.includes(name));
        expect(sorted(rowKeys(section('### `bridge`')))).toEqual(sorted(bridge));

        const files = Object.keys(inSandboxFiles([]));
        delete (globalThis as any).sandboxFiles;
        expect(sorted(rowKeys(section('### `sandboxFiles`')))).toEqual(sorted(files));

        const view = read('src/lib/in-sandbox-view.ts').match(/g\.sandboxView = Object\.freeze\(\{([^}]+)\}\)/)![1]!.split(',').map(name => name.trim());
        const viewSection = section('### `sandboxView`');
        expect(sorted(rowKeys(viewSection))).toEqual(sorted(view));
        const viewSpans = spans(viewSection);
        for (const type of VIEW_EVENT_TYPES) expect(viewSpans.has(type), type).toBe(true);
        for (const element of RENDER_REMOVED_ELEMENTS) expect(viewSpans.has(element), element).toBe(true);
        expect(viewSection).toContain(`Strings are cut at ${VIEW_EVENT_LIMITS.maxString} characters, \`ids\` at ${VIEW_EVENT_LIMITS.maxIds} entries, \`form\` at ${VIEW_EVENT_LIMITS.maxFields} fields`);
    });

    it('describes the current design only: no backlog ids or history', () => {
        expect(DOC).not.toMatch(/\b[BCDHST]\d{1,2}\b/);
        expect(DOC).not.toMatch(/\b(previously|no longer|used to|backlog)\b/i);
    });
});
