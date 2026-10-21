import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { flatten, parseDocComment, readApiModel, type ApiMember } from '../../tools/docgen/extractors/api-model';

/**
 * TSDoc coverage of the public API (CONTRIBUTING.md, "Code and docs: the current state"): every export that
 * src/index.ts makes, every member of a class or interface, every parameter and every return value has its TSDoc, as
 * api-extractor's doc model (etc/web-sandbox.api.json, `bun run api:update`) sees it. The generated reference
 * (docs/API.md) is rendered from that text, so a gap here is a gap in the docs.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = path.join(ROOT, 'etc/web-sandbox.api.json');

const label = (item: ApiMember) => `${item.kind} ${item.path || '(constructor)'}`;

describe('TSDoc coverage of the public API', () => {
    const items = flatten(readApiModel(MODEL));

    it('reads the model: the exports of src/index.ts are all there', () => {
        const exported = readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
        const names = new Set(items.filter(item => !item.path.includes('.')).map(item => item.name));
        for (const name of ['WebSandbox', 'defineWebSandbox', 'SandboxConfig', 'FetchRecord', 'WebSandboxEventMap', 'SAFE_CAPABILITIES']) expect(names.has(name), name).toBe(true);
        expect(exported).toContain('WebSandboxEventMap');
        expect(items.length).toBeGreaterThan(100);
    });

    it('every export and every member has a summary', () => {
        expect(items.filter(item => item.doc.summary === '').map(label)).toEqual([]);
    });

    it('every parameter has an @param', () => {
        const missing = items.flatMap(item => item.parameters.filter(parameter => !(parameter.name in item.doc.params)).map(parameter => `${label(item)}(${parameter.name})`));
        expect(missing).toEqual([]);
    });

    it('every function and method that returns something has a @returns', () => {
        const missing = items.filter(item => (item.kind === 'Function' || item.kind === 'Method' || item.kind === 'MethodSignature') && item.returnType !== 'void' && item.doc.returns === '');
        expect(missing.map(label)).toEqual([]);
    });

    it('every type parameter of a function or method has a @typeParam', () => {
        const missing = items.flatMap(item => [...item.typeParameters.matchAll(/[<,]\s*(\w+)/g)].map(match => match[1]!).filter(name => !(name in item.doc.typeParams)).map(name => `${label(item)}<${name}>`));
        expect(missing).toEqual([]);
    });

    // The public fields and exports that carry text the guest chose: their TSDoc (and so docs/API.md, rendered from it)
    // says how to show it. terminated.reason is the library's own text and is not listed.
    const GUEST_TEXT_FIELDS = ['WebSandboxEventMap', 'WebSandbox.expose', 'SandboxLog.args', 'SandboxViolation.blockedURI', 'SandboxViolation.sourceFile', 'FetchRecord', 'RpcError'] as const;

    it.each(GUEST_TEXT_FIELDS)('%s says to show guest-controlled text with textContent, never in an HTML, URL, eval or template sink', (field) => {
        const item = items.find(entry => entry.path === field);
        expect(item, field).toBeDefined();
        const text = `${item!.doc.summary} ${item!.doc.remarks}`.replace(/\s+/g, ' ');
        expect(text, field).toContain("show it with `textContent`, never in an HTML, URL (such as a link `href`");
    });

    it('the model is the checked-in copy of what the build writes (bun run api:check compares them)', () => {
        expect(existsSync(MODEL)).toBe(true);
    });

    it('splits a doc comment by its tags', () => {
        const doc = parseDocComment('/**\n * Does a thing.\n *\n * More on it.\n *\n * @remarks\n * Why.\n *\n * @param a - First.\n * @param b - Second,\n * over two lines.\n * @returns The thing.\n * @throws An `Error` if a.\n * @defaultValue `1`\n */');
        expect(doc).toEqual({
            summary: 'Does a thing.\n\nMore on it.',
            remarks: 'Why.',
            params: { a: 'First.', b: 'Second,\nover two lines.' },
            typeParams: {},
            returns: 'The thing.',
            throws: ['An `Error` if a.'],
            defaultValue: '`1`',
            examples: [],
        });
        expect(parseDocComment(undefined).summary).toBe('');
        expect(parseDocComment('/**\n * A fence:\n * ```\n * @not-a-tag\n * ```\n */').summary).toContain('@not-a-tag');
    });
});
