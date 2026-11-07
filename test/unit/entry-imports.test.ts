import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { dynamicImportAt } from '@src/lib/entry-imports';

/**
 * The build's scan for a dynamic `import()` in a strict or sealed entry (entry-imports.ts; S74, class A:
 * INHERITED_CONTEXT.cspReporting; BD6:ISO-2). It may find one the engine would not run, never miss one it would. The engine
 * is the judge: a child Node runs each text as a classic script (the worker's entry is one) with a hook that records every
 * `import()` it evaluates, and the scan must have found an `import` in every text whose hook was called.
 */

// Runs each text of stdin's JSON list as a classic script and answers, for each, whether it evaluated an import().
const RUNNER = `
import vm from 'node:vm';
process.on('unhandledRejection', () => {});
let input = '';
for await (const chunk of process.stdin) input += chunk;
const sources = JSON.parse(input);
const imported = sources.map(() => false);
for (let i = 0; i < sources.length; i++) {
    let script;
    try {
        script = new vm.Script(sources[i], { importModuleDynamically: () => { imported[i] = true; throw new Error('no module'); } });
    } catch { continue; }
    try { script.runInContext(vm.createContext({}), { timeout: 50 }); } catch {}
}
await new Promise((resolve) => setTimeout(resolve, 20));
process.stdout.write(JSON.stringify(imported));
`;

/** Whether the engine evaluates an import() in each of `sources`. */
function engineImports(sources: readonly string[]): boolean[] {
    const output = execFileSync('node', ['--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e', RUNNER], { input: JSON.stringify(sources), maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(output.toString()) as boolean[];
}

// Texts where a reading of the entry other than the engine's would miss an import() the engine runs, or find one it
// would not.
const RUNS_IMPORT = [
    "import('https://x.example/a')",
    'import (`https://x.example/b`)',
    "import\n('c')",
    "import/* a comment */('d')",
    "import// a comment\n('e')",
    "import\u2028('g')",
    // a classic script reads `<!--` as a comment, so the backtick after it opens no template; a module's lexer reads
    // operators and a template, which would hide the import() on the next line
    "var x; x <!-- `\nimport('i')\n// `",
    "var x = 1\n--> `\nimport('j')\n// `",
    "const u = 'k'; import(u)",
    "x = {} / 1 / import('l')",
    "if (1) /re/.test(import('m'))",
    "label: { import('n') }",
];
const RUNS_NONE = [
    "ximport('a')",
    "import$('b')",
    "obj.import_('c')",
    'const imports = 1',
    "'no import here'",
];

describe('dynamicImportAt: the scan never misses an import() the engine runs', () => {
    it('the hand-written texts: the engine runs each import() the scan finds', () => {
        expect(engineImports(RUNS_IMPORT)).toEqual(RUNS_IMPORT.map(() => true));
        expect(RUNS_IMPORT.filter(source => dynamicImportAt(source) < 0)).toEqual([]);
        expect(engineImports(RUNS_NONE)).toEqual(RUNS_NONE.map(() => false));
        expect(RUNS_NONE.filter(source => dynamicImportAt(source) >= 0)).toEqual([]);
    });

    it('it finds what a string or a comment holds too (it fails closed)', () => {
        expect(dynamicImportAt("const text = 'import(x)';")).toBeGreaterThanOrEqual(0);
        expect(dynamicImportAt('// call import() later')).toBeGreaterThanOrEqual(0);
    });

    it('generated texts: every one whose import() the engine evaluates is found by the scan', () => {
        // pieces that open and close strings, templates, comments and regular expressions around an import, and every
        // separator the language reads as whitespace or a comment between it and its parenthesis
        const piece = fc.constantFrom(
            'import', '(', ')', "'u'", '"', "'", '`', '${', '}', '/', '*', '/*', '*/', '//', '<!--', '-->',
            '\n', '\r', ' ', '\t', '\u2028', '\u00a0', '\ufeff', 'x', 'x.', '=', ';', '{', '\\', '\\u0069', '0', ',', '+', '-',
            '>', '<', '!', 'if (1)', 'return', 'function f() {', '.', 'meta', '/re/', '/re/g.test(', 'await', 'async', '=>',
        );
        const trivia = fc.constantFrom(' ', '\n', '\r\n', '\t', '\u2028', '\u2029', '\u00a0', '\ufeff', '\u3000', '/**/', '/* x */', '// x\n', '<!-- x\n', '\n--> x\n', '\v', '\f');
        const around = fc.array(piece, { maxLength: 6 }).map(pieces => pieces.join(''));
        const text = fc.tuple(around, fc.array(trivia, { maxLength: 3 }), fc.constantFrom("('u')", '(`u`)', '(x)', "('u', {})"), around)
            .map(([before, between, call, after]) => `${before}import${between.join('')}${call}${after}`);
        const samples = fc.sample(text, { numRuns: 6000, seed: 20261107 });
        const engine = engineImports(samples);
        const ran = samples.filter((_, i) => engine[i]);
        expect(ran.length).toBeGreaterThan(100); // the generator reaches the engine's import() often enough to judge
        expect(ran.filter(source => dynamicImportAt(source) < 0)).toEqual([]);
    }, 60000);
});
