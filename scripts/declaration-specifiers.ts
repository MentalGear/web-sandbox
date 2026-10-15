/**
 * Gives every relative specifier in the emitted declarations (dist/**\/*.d.ts) its `.js` extension (review round 1,
 * R4-3). tsc emits a declaration's imports as the sources wrote them, extensionless (the sources are resolved by a
 * bundler), and a consumer type-checking under `module`/`moduleResolution: NodeNext` refuses those (TS2834); with
 * skipLibCheck every type of the package then read as `any`, silently. Each specifier must name an emitted declaration
 * (`x.d.ts`, or `x/index.d.ts`), else the build fails: a specifier this cannot place is never left as it was.
 * Run by `bun run build:lib` after tsc; scripts/smoke-package.sh type-checks a NodeNext consumer against the result.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = join(import.meta.dir, '..', 'dist');

function declarations(directory: string): string[] {
    const found: string[] = [];
    for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) found.push(...declarations(path));
        else if (name.endsWith('.d.ts')) found.push(path);
    }
    return found;
}

// `from "./x"`, `import("./x")`, `import "./x"`: the specifier is the quoted relative path.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*)\2/g;

function withExtension(file: string, specifier: string): string {
    if (specifier.endsWith('.js')) return specifier;
    const base = join(dirname(file), specifier);
    if (existsSync(`${base}.d.ts`)) return `${specifier}.js`;
    if (existsSync(join(base, 'index.d.ts'))) return `${specifier}/index.js`;
    throw new Error(`${relative(root, file)}: "${specifier}" names no emitted declaration`);
}

let changed = 0;
for (const file of declarations(root)) {
    const source = readFileSync(file, 'utf8');
    const rewritten = source.replace(SPECIFIER, (_match, keyword: string, quote: string, specifier: string) => `${keyword}${quote}${withExtension(file, specifier)}${quote}`);
    if (rewritten === source) continue;
    writeFileSync(file, rewritten);
    changed++;
}
console.log(`declaration specifiers: ${changed} file(s) given .js extensions`);
