/**
 * Names the element's base class as `HTMLElement` in the emitted declarations (dist/host.d.ts), in place of the
 * module-private `ElementBase` (src/host.ts) that tsc names there. `ElementBase` is a stand-in for import without a
 * DOM, typed `typeof HTMLElement`, so `extends HTMLElement` is the same public type, and the stand-in never becomes a
 * public name the package would have to export (api-extractor's `ae-forgotten-export`; backlog S76, decision C).
 * The declarations must hold the pair exactly once, else the build fails: the rewrite never silently does nothing.
 * Run by `bun run build:lib` after tsc; `bun run api:check` reads the result.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DECLARED = 'declare const ElementBase: typeof HTMLElement;\n';
const EXTENDS = 'export declare class WebSandbox extends ElementBase {';

/** `source` with the stand-in's declaration removed and the class declared on `HTMLElement`; throws if either is missing. */
export function declareOnHTMLElement(source: string): string {
    for (const text of [DECLARED, EXTENDS]) {
        if (source.split(text).length !== 2) throw new Error(`declaration base: expected "${text.trim()}" exactly once in host.d.ts`);
    }
    return source.replace(DECLARED, '').replace(EXTENDS, 'export declare class WebSandbox extends HTMLElement {');
}

if (import.meta.main) {
    const file = join(import.meta.dir, '..', 'dist', 'host.d.ts');
    writeFileSync(file, declareOnHTMLElement(readFileSync(file, 'utf8')));
    console.log('declaration base: WebSandbox extends HTMLElement in dist/host.d.ts');
}
