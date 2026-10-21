import { describe, it, expect, vi } from 'vitest';
import { applyEdits, moduleSpecifierEdits, resolveModuleSpecifier, rewriteInlineModule, VIRTUAL_ROOT } from './module-specifiers';

/**
 * The host-side rewrite of a registered module's relative specifiers (ADR-004). What it
 * guarantees: every relative specifier in an import or export-from statement and in a literal import()
 * becomes the JSON string of a URL inside https://vfs.invalid/; nothing else in the source changes.
 */

const rewrite = (source: string, path = 'app/main.js') => applyEdits(source, moduleSpecifierEdits(source, VIRTUAL_ROOT + path));
const url = (path: string) => JSON.stringify(VIRTUAL_ROOT + path);

describe('resolveModuleSpecifier: only relative specifiers, and only into the virtual origin', () => {
    const BASE = VIRTUAL_ROOT + 'app/lib/a.js';
    it.each([
        ['./b.js', 'https://vfs.invalid/app/lib/b.js'],
        ['../b.js', 'https://vfs.invalid/app/b.js'],
        ['/b.js', 'https://vfs.invalid/b.js'],
        ['./', 'https://vfs.invalid/app/lib/'],
        ['../../../../../b.js', 'https://vfs.invalid/b.js'], // '..' above the root clamps to the root
        ['/../b.js', 'https://vfs.invalid/b.js'],
        ['./%2e%2e/%2e%2e/%2e%2e/b.js', 'https://vfs.invalid/b.js'], // encoded dot segments are dot segments
        ['./b.js?v=1#x', 'https://vfs.invalid/app/lib/b.js?v=1#x'],
        ['./<script>.js', 'https://vfs.invalid/app/lib/%3Cscript%3E.js'],
        ['./"quote".js', 'https://vfs.invalid/app/lib/%22quote%22.js'],
    ])('%j resolves to %s', (specifier, expected) => {
        expect(resolveModuleSpecifier(specifier, BASE)).toBe(expected);
    });

    it.each([
        ['bare', 'lodash'],
        ['bare with slash', 'app/b.js'],
        ['dot without slash', '.b.js'],
        ['lone dot', '.'],
        ['lone dots', '..'],
        ['full URL', 'https://cdn.example/x.js'],
        ['full URL into the virtual origin', 'https://vfs.invalid/b.js'],
        ['blob URL', 'blob:null/1234'],
        ['data URL', 'data:text/javascript,1'],
        ['scheme-relative', '//attacker.test/x.js'],
        ['backslash scheme-relative', '/\\attacker.test/x.js'],
        ['empty', ''],
    ])('leaves a %s specifier alone (%j)', (_label, specifier) => {
        expect(resolveModuleSpecifier(specifier, BASE)).toBeNull();
    });
});

describe('moduleSpecifierEdits: every import form', () => {
    it.each([
        ['default import', "import a from './a.js';", `import a from ${url('app/a.js')};`],
        ['named import', 'import { a, b as c } from "../a.js";', `import { a, b as c } from ${url('a.js')};`],
        ['namespace import', "import * as ns from '/lib/a.js';", `import * as ns from ${url('lib/a.js')};`],
        ['side-effect import', "import './side.js';", `import ${url('app/side.js')};`],
        ['side-effect import, no space', "import'./side.js'", `import${url('app/side.js')}`],
        ['export * from', "export * from './a.js';", `export * from ${url('app/a.js')};`],
        ['export * as from', "export * as ns from './a.js';", `export * as ns from ${url('app/a.js')};`],
        ['export { } from', "export { a, b as default } from './a.js';", `export { a, b as default } from ${url('app/a.js')};`],
        ['import attributes', "import data from './d.json' with { type: 'json' };", `import data from ${url('app/d.json')} with { type: 'json' };`],
        ['string import names', 'import { "a-b" as ab } from "./a.js";', `import { "a-b" as ab } from ${url('app/a.js')};`],
        ['multi-line import', "import {\n  a,\n  b,\n} from\n  './a.js';", `import {\n  a,\n  b,\n} from\n  ${url('app/a.js')};`],
        ['dynamic import, single quotes', "const m = import('./a.js');", `const m = import(${url('app/a.js')});`],
        ['dynamic import, double quotes', 'await import("../a.js")', `await import(${url('a.js')})`],
        ['dynamic import, spaces and options', "import(  './a.js' , { with: { type: 'json' } })", `import(  ${url('app/a.js')} , { with: { type: 'json' } })`],
        ['dynamic import, plain template', 'import(`./a.js`)', `import(${url('app/a.js')})`],
        ['dynamic import inside a template substitution', 'const t = `${await import("./a.js")}`;', `const t = \`\${await import(${url('app/a.js')})}\`;`],
        ['dynamic import inside a function', 'function f() { return import("./a.js") }', `function f() { return import(${url('app/a.js')}) }`],
        ['escaped specifier', "import './\\u0061.js';", `import ${url('app/a.js')};`],
        ['source phase import', "import source mod from './m.wasm';", `import source mod from ${url('app/m.wasm')};`],
        ['defer phase import', "import defer * as d from './d.js';", `import defer * as d from ${url('app/d.js')};`],
        ['non-ASCII specifier', "import './é.js';", `import ${url('app/%C3%A9.js')};`],
    ])('%s', (_label, source, expected) => {
        expect(rewrite(source)).toBe(expected);
    });

    it('rewrites several imports in one module, in order, and changes nothing between them', () => {
        const source = "import a from './a.js';\nconst x = 1; // keep\nexport * from '../b.js';\nimport('/c.js');\n";
        expect(rewrite(source)).toBe(`import a from ${url('app/a.js')};\nconst x = 1; // keep\nexport * from ${url('b.js')};\nimport(${url('c.js')});\n`);
    });

    it("clamps '..' above the root: the result stays inside https://vfs.invalid/", () => {
        expect(rewrite("import '../../../../x.js'; import('/../../y.js');", 'a.js')).toBe(`import ${url('x.js')}; import(${url('y.js')});`);
    });

    it('skips a byte order mark (the lexer finds nothing at all behind one) and keeps it', () => {
        const source = "﻿import './a.js';";
        expect(rewrite(source)).toBe(`﻿import ${url('app/a.js')};`);
    });
});

describe('moduleSpecifierEdits: what it leaves alone', () => {
    it.each([
        ['a string', `const s = "import './a.js'"; const t = 'export * from "./b.js"';`],
        ['a line comment', "// import './a.js'\nconst x = 1;"],
        ['a block comment', "/* import './a.js'; import('./b.js') */ const x = 1;"],
        ['a regular expression', "const r = /import '.\\/a.js'/; const q = x / import.meta.url.length / 2;"],
        ['a template literal', "const t = `import './a.js' ${1} import('./b.js')`;"],
        ['computed import()', "const name = 'a.js'; import('./' + name); import(`./${name}`); import(name);"],
        ['import.meta', 'const u = new URL("./a.js", import.meta.url); import.meta.resolve("./b.js");'],
        ['bare specifiers', "import x from 'lodash'; import('app/b.js'); export * from 'pkg/sub';"],
        ['full URLs', "import x from 'https://cdn.example/x.js'; import('https://vfs.invalid/b.js');"],
        ['scheme-relative specifiers', "import x from '//attacker.test/x.js'; import('/\\\\attacker.test/y.js');"],
        ['a property named import', "obj.import('./a.js'); const o = { import: './a.js' };"],
        ['a classic script without imports', 'globalThis.x = 1; document.title = "import \'./a.js\'";'],
    ])('import-like text in %s', (_label, source) => {
        expect(moduleSpecifierEdits(source, VIRTUAL_ROOT + 'app/main.js')).toEqual([]);
        expect(rewrite(source)).toBe(source);
    });

    it('throws when the lexer cannot parse the source (the caller delivers the file unchanged)', () => {
        expect(() => moduleSpecifierEdits('import {', VIRTUAL_ROOT + 'a.js')).toThrow();
        expect(() => moduleSpecifierEdits("import a from './a.js'; const x = `", VIRTUAL_ROOT + 'a.js')).toThrow();
    });
});

describe('rewriteInlineModule (inline <script type="module"> in guest markup)', () => {
    const DOCUMENT_URL = VIRTUAL_ROOT + 'index.html';

    it('resolves against the virtual document URL', () => {
        expect(rewriteInlineModule("import { a } from './app/a.js'; import('/b.js');", DOCUMENT_URL, () => {}))
            .toBe(`import { a } from ${url('app/a.js')}; import(${url('b.js')});`);
    });

    it('returns null when nothing changes', () => {
        expect(rewriteInlineModule("import x from 'lodash'; console.log(1);", DOCUMENT_URL, () => {})).toBeNull();
    });

    it("leaves the whole script alone when a specifier to replace contains '<' or '>', which could move where the script ends when the markup is parsed again", () => {
        expect(rewriteInlineModule("import './a.js'; import './<!--x.js';", DOCUMENT_URL, () => {})).toBeNull();
        expect(rewriteInlineModule("import './a.js'; import('./-->.js');", DOCUMENT_URL, () => {})).toBeNull();
    });

    it('reports a lexer failure once and leaves the script alone', () => {
        const onFailure = vi.fn();
        expect(rewriteInlineModule("import './a.js'; import {", DOCUMENT_URL, onFailure)).toBeNull();
        expect(onFailure).toHaveBeenCalledTimes(1);
    });

    it('never produces "<" or ">" in a replacement, whatever the specifier (the URL parser percent-encodes them)', () => {
        const source = "import './a<b>.js'; import('./c?<d>#<e>');";
        const edits = moduleSpecifierEdits(source, DOCUMENT_URL);
        expect(edits).toHaveLength(2);
        for (const edit of edits) expect(edit.text).not.toMatch(/[<>]/);
    });
});
