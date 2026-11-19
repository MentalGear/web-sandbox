import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { code } from './call-graph';

/**
 * The module graph of src/: which module imports which, read from the import and export declarations of each file
 * (comments are not code). An edge is `runtime` unless its declaration is `import type` or `export type`, which no
 * build keeps; a declaration that names only inline `type` specifiers stays a runtime edge, as the compiler keeps the
 * import itself (verbatimModuleSyntax). Shared by the scans of what a build of the package is made of
 * (test/unit/default-build.test.ts; ADR-009).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface ModuleEdge {
    readonly to: string;
    /** false for `import type` and `export type`: no code of the target is reached. */
    readonly runtime: boolean;
}

const DECLARATION = /^(?:import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?(['"])([^'"]+)\2/gm;

function resolve(from: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const base = path.posix.join(path.posix.dirname(from), specifier);
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) if (existsSync(path.join(ROOT, candidate))) return candidate;
    throw new Error(`${from}: "${specifier}" names no module`);
}

/** The modules `file` imports or re-exports from, each once: runtime if any declaration of it is. */
export function edgesOf(file: string): ModuleEdge[] {
    const edges = new Map<string, boolean>();
    for (const match of code(file).matchAll(DECLARATION)) {
        const to = resolve(file, match[3]!);
        if (to === null) continue;
        edges.set(to, (edges.get(to) ?? false) || match[1] === undefined);
    }
    return [...edges].map(([to, runtime]) => ({ to, runtime }));
}

/** Every module reachable from `entry`, itself included: over runtime edges only, or over every edge (`types`). */
export function reachable(entry: string, types = false): Set<string> {
    const seen = new Set<string>();
    const pending = [entry];
    while (pending.length > 0) {
        const file = pending.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        for (const edge of edgesOf(file)) if (edge.runtime || types) pending.push(edge.to);
    }
    return seen;
}

/** The modules of src/ (no tests), repository-relative. */
export function sourceModules(directory = 'src'): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) files.push(...sourceModules(relative));
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(relative);
    }
    return files.sort();
}
