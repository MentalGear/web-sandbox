import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { dynamicImportAt, pastTrivia } from '@src/lib/entry-imports';

/**
 * The build's scan for an import expression in a strict or sealed entry (entry-imports.ts; S74, class A:
 * INHERITED_CONTEXT.cspReporting; BD6:ISO-2, BD7:CHL-1). It may find one the engine would not run, never miss one it would.
 * The engine is the judge: a child Node runs each text as a classic script (the worker's entry is one) with a hook that
 * records every `import()` it evaluates, and the scan must have found an `import` in every text whose hook was called.
 * The phases of an import (`import.source(…)`, `import.defer(…)`), which the engine of this suite cannot run, are judged
 * by the grammar: every form `import`, trivia, `(`; and `import`, trivia, `.`, trivia, a phase's name, trivia, `(`. Its
 * cost is linear (BD7:LIM-2): host-passes.test.ts times it on the shapes that were quadratic.
 */

/** The reading the scan keeps (the trivia after one index), as it was written before it was read in one pass: the reference. */
function pastTriviaAt(text: string, from: number): number {
    let at = from;
    while (at < text.length) {
        if (/\s/.test(text[at]!)) {
            at++;
            continue;
        }
        if (text.startsWith('/*', at)) {
            const end = text.indexOf('*/', at + 2);
            if (end < 0) return text.length;
            at = end + 2;
            continue;
        }
        if (!(text.startsWith('//', at) || text.startsWith('<!--', at) || text.startsWith('-->', at))) return at;
        while (at < text.length && !/[\n\r\u2028\u2029]/.test(text[at]!)) at++;
    }
    return at;
}

// Trivia of every kind the language has between `import` and what follows it.
const TRIVIA = ['', ' ', '\n', '\r\n', '\t', '\v', '\f', '\u00a0', '\ufeff', '\u2028', '\u2029', '\u3000', '/**/', '/* x */', '/*\n*/', '// x\n', '<!-- x\n', '\n--> x\n'] as const;

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

// Answers, for each text of stdin's JSON list, whether it compiles as a classic script.
const COMPILER = `
import vm from 'node:vm';
let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify(JSON.parse(input).map((source) => { try { new vm.Script(source); return true; } catch { return false; } })));
`;

/** Whether the engine compiles each of `sources` as a classic script. */
function engineCompiles(sources: readonly string[]): boolean[] {
    const output = execFileSync('node', ['--no-warnings', '--input-type=module', '-e', COMPILER], { input: JSON.stringify(sources) });
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

describe('every form of an import expression is refused, its phases too (BD7:CHL-1)', () => {
    // The names a phase of an import has or could have: the two proposals, and any name a later one could take.
    const PHASES = ['source', 'defer', 'meta', 'evaluation', 'x', '$', '_phase'] as const;
    const trivia = fc.constantFrom(...TRIVIA);
    const around = fc.array(fc.constantFrom('x', ' ', ';', '\n', '(', ')', '.', "'", '"', '`', '/', '*', '{', '}', 'import', 'imports', 'ximport'), { maxLength: 6 }).map(pieces => pieces.join(''));

    it("the grammar's forms: `import`, trivia, `(`; and `import`, trivia, `.`, trivia, a phase, trivia, `(`: each is found, wherever it stands", () => {
        const call = trivia.map(between => `import${between}('u')`);
        const phase = fc.tuple(trivia, trivia, fc.constantFrom(...PHASES), trivia).map(([a, b, name, c]) => `import${a}.${b}${name}${c}('u')`);
        const text = fc.tuple(around, fc.oneof(call, phase), around).map(([before, form, after]) => ({ text: `${before};${form}${after}`, at: before.length + 1 }));
        const samples = fc.sample(text, { numRuns: 4000, seed: 20261107 });
        // found at the form, or at an earlier `import` the scan reads as one (it fails closed: never later, never missed)
        const missed = samples.filter(({ text: source, at }) => {
            const found = dynamicImportAt(source);
            return found < 0 || found > at;
        });
        expect(missed).toEqual([]);
        for (const name of PHASES) expect(dynamicImportAt(`const m = await import.${name}('u');`), name).toBe(16);
        for (const between of TRIVIA) expect(dynamicImportAt(`import${between}.source(x)`), JSON.stringify(between)).toBe(0);
    });

    it('in a classic script an `import` the engine reads as a token is one of those forms: a static import and import.meta do not compile', () => {
        const statics = ["import x from 'y'", "import 'y'", "import * as n from 'y'", "import { a } from 'y'", 'import.meta', 'import.meta.url', "import defer * as n from 'y'", "import source x from 'y'", 'x = import', 'import\nx', 'import;'];
        expect(engineCompiles(statics)).toEqual(statics.map(() => false));
        const words = ["import('y')", 'x.import = 1', '({ import: 1 })', 'imports = 1'];
        expect(engineCompiles(words), 'positive control: an import call, and the word as a property or a longer name').toEqual(words.map(() => true));
    });

    it('what is no form of one is not found: a longer name, and `import` followed by anything but `(` or `.`', () => {
        for (const source of ['imports(x)', 'ximport(x)', 'import$(x)', 'import_.x', '({ import: 1 })', 'x.import = 1', "import x from 'y'", 'import', 'import // (\n x']) {
            expect(dynamicImportAt(source), source).toBe(-1);
        }
    });
});

describe('the trivia, read in one pass, is the reading it replaced (BD7:LIM-2)', () => {
    it('at every index of generated texts, pastTrivia gives what the reference reading gives from that index', () => {
        const piece = fc.constantFrom(...TRIVIA, '/*', '*/', '*', '/', '//', '<!--', '<!-', '-->', '--', '-', '<', '!', 'import', '(', '.', 'x', '\n', '\r', '\u2028', '\u0085', '\u180e', '\u200b');
        const texts = fc.sample(fc.array(piece, { maxLength: 24 }).map(pieces => pieces.join('')), { numRuns: 3000, seed: 20261107 });
        const differ: { text: string; at: number; from: number }[] = [];
        for (const text of texts) {
            for (const from of [0, text.length >> 1]) {
                const past = pastTrivia(text, from);
                for (let at = from; at <= text.length; at++) if (past[at] !== pastTriviaAt(text, at)) differ.push({ text, at, from });
            }
        }
        expect(differ).toEqual([]);
    });
});
