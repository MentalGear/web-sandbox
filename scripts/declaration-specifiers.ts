/**
 * Gives every relative specifier in the emitted declarations (dist/**\/*.d.ts) its `.js` extension (review round 1,
 * R4-3). tsc emits a declaration's imports as the sources wrote them, extensionless (the sources are resolved by a
 * bundler), and a consumer type-checking under `module`/`moduleResolution: NodeNext` refuses those (TS2834); with
 * skipLibCheck every type of the package then read as `any`, silently. Each specifier must name an emitted declaration
 * (`x.d.ts`, or `x/index.d.ts`), else the build fails: a specifier this cannot place is never left as it was.
 * Run by `bun run build:lib` after tsc; scripts/smoke-package.sh type-checks a NodeNext consumer against the result.
 *
 * Only the specifiers of real import and export declarations and import types are rewritten (review round 2, C-11), found
 * among the text's tokens (js-tokens.ts: TypeScript's own scanner): `from "./x"`, `import "./x"` and `import("./x")`. A
 * regular expression over the text also rewrote such a phrase inside a comment (a doc comment that quotes an import) or
 * a string, where it is not a specifier; the scanner never yields a token from either.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { SyntaxKind, tokenize } from './js-tokens';

/** The text with every relative import or export specifier replaced by `place(specifier)`; comments and strings untouched. */
export function rewriteSpecifiers(source: string, place: (specifier: string) => string): string {
    const tokens = tokenize(source);
    let out = '';
    let at = 0;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.kind !== SyntaxKind.StringLiteral || !isSpecifierPosition(tokens, i)) continue;
        const quote = token.text[0]!;
        const specifier = token.text.slice(1, -1);
        if (!/^\.{1,2}\//.test(specifier)) continue;
        out += source.slice(at, token.start) + quote + place(specifier) + quote;
        at = token.end;
    }
    return out + source.slice(at);
}

// Whether the string literal at `index` is a module specifier: after `from`, after `import`, or as the argument of
// `import(` (an import type); never a property access (`x.import`, `x.from`).
function isSpecifierPosition(tokens: { kind: SyntaxKind }[], index: number): boolean {
    const before = tokens[index - 1]?.kind;
    const notMember = (at: number) => tokens[at - 1]?.kind !== SyntaxKind.DotToken;
    if (before === SyntaxKind.FromKeyword) return notMember(index - 1);
    if (before === SyntaxKind.ImportKeyword) return notMember(index - 1);
    return before === SyntaxKind.OpenParenToken && tokens[index - 2]?.kind === SyntaxKind.ImportKeyword && notMember(index - 2)
        && tokens[index + 1]?.kind === SyntaxKind.CloseParenToken;
}

function declarations(directory: string): string[] {
    const found: string[] = [];
    for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) found.push(...declarations(path));
        else if (name.endsWith('.d.ts')) found.push(path);
    }
    return found;
}

function withExtension(root: string, file: string, specifier: string): string {
    if (specifier.endsWith('.js')) return specifier;
    const base = join(dirname(file), specifier);
    if (existsSync(`${base}.d.ts`)) return `${specifier}.js`;
    if (existsSync(join(base, 'index.d.ts'))) return `${specifier}/index.js`;
    throw new Error(`${relative(root, file)}: "${specifier}" names no emitted declaration`);
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', 'dist');
    let changed = 0;
    for (const file of declarations(root)) {
        const source = readFileSync(file, 'utf8');
        const rewritten = rewriteSpecifiers(source, (specifier) => withExtension(root, file, specifier));
        if (rewritten === source) continue;
        writeFileSync(file, rewritten);
        changed++;
    }
    console.log(`declaration specifiers: ${changed} file(s) given .js extensions`);
}
