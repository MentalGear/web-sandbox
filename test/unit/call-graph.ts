import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comments, SyntaxKind, tokenize } from '../../scripts/js-tokens';

/**
 * A call graph over src/: a node is a module-level function or const of a file, or a member of host.ts's element class;
 * an edge is any reference to one in another's text (a call, or a function handed on), resolved through the file's
 * imports. Conservative: a reference counts as a call. Comments are not code. The lifecycle executor (`step`) is where a
 * path hands the reducer an input and ends: what the reducer starts from it is a build path of its own.
 *
 * Shared by the scans that ask what a path of the code can reach: sealed mode's build path (test/unit/sealed-build.test.ts,
 * research 24's T5) and the host realm's passes over guest content (test/unit/host-passes.test.ts, HOST_PASSES).
 */
export type Graph = { units: Map<string, string>; imports: Map<string, string> };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const files = new Map<string, Graph>();
const BOUNDARY = new Set(['src/host.ts#step']);

/** A file of the repository (repository-relative), comments blanked: what the graph reads as code. */
export function code(file: string): string {
    let text = readFileSync(path.join(ROOT, file), 'utf8');
    for (const comment of comments(text)) text = text.slice(0, comment.start) + ' '.repeat(comment.end - comment.start) + text.slice(comment.end);
    return text;
}

function resolve(from: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const base = path.posix.join(path.posix.dirname(from), specifier);
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) if (existsSync(path.join(ROOT, candidate))) return candidate;
    return null;
}

/** The units of `file` (its module-level functions and consts; host.ts's element members as `this.name`) and its imports. */
export function graphOf(file: string): Graph {
    const known = files.get(file);
    if (known) return known;
    const text = code(file);
    const imports = new Map<string, string>();
    for (const match of text.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/gm)) {
        if (match[1]) continue;
        const target = resolve(file, match[3]!);
        if (!target) continue;
        for (const part of match[2]!.split(',').map(entry => entry.trim()).filter(entry => entry && !entry.startsWith('type '))) {
            const [name, local] = part.split(/\s+as\s+/);
            imports.set((local ?? name)!, `${target}#${name}`);
        }
    }
    const units = new Map<string, string>();
    const starts: { name: string; at: number; close: RegExp }[] = [];
    for (const match of text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)) starts.push({ name: match[1]!, at: match.index!, close: /^\}$/m });
    for (const match of text.matchAll(/^(?:export\s+)?const\s+(\w+)/gm)) starts.push({ name: match[1]!, at: match.index!, close: /^(?=\S)/m });
    // a class of a module (its methods are its text), but host.ts's element, whose members are units of their own
    if (file !== 'src/host.ts') for (const match of text.matchAll(/^(?:export\s+)?class\s+(\w+)/gm)) starts.push({ name: match[1]!, at: match.index!, close: /^\}$/m });
    if (file === 'src/host.ts') {
        // the element class's members only (the interfaces below it name some of the same members)
        const from = text.indexOf('\nexport class WebSandbox ');
        const to = text.indexOf('\n}\n', from);
        const body = text.slice(from, to);
        for (const match of body.matchAll(/^ {4}(?:(?:private|public|static|async|get|set)\s+)*(\w+)\s*\(/gm)) starts.push({ name: `this.${match[1]}`, at: from + match.index!, close: /^ {4}\}$/m });
    }
    for (const start of starts) {
        // the unit's text: its first line, and every line up to the one that closes it
        const lineEnd = text.indexOf('\n', start.at);
        const rest = text.slice(lineEnd + 1);
        const end = rest.search(start.close);
        units.set(start.name, text.slice(start.at, lineEnd + 1) + (end < 0 ? rest : rest.slice(0, end)));
    }
    const graph = { units, imports };
    files.set(file, graph);
    return graph;
}

/** The nodes a text references: `this.name` (host.ts's members), a module-level unit of its file, an import. */
export function references(file: string, text: string): string[] {
    const { units, imports } = graphOf(file);
    const tokens = tokenize(text);
    const found = new Set<string>();
    tokens.forEach((token, i) => {
        if (token.kind !== SyntaxKind.Identifier) return;
        const before = tokens[i - 1];
        if (before?.kind === SyntaxKind.DotToken || before?.kind === SyntaxKind.QuestionDotToken) {
            if (tokens[i - 2]?.kind === SyntaxKind.ThisKeyword && units.has(`this.${token.text}`)) found.add(`${file}#this.${token.text}`);
            return;
        }
        if (units.has(token.text)) found.add(`${file}#${token.text}`);
        else if (imports.has(token.text)) found.add(imports.get(token.text)!);
    });
    return [...found];
}

/** Every node reachable from `text` of `file`, and the path that reached each. */
export function reach(file: string, text: string): Map<string, string[]> {
    const paths = new Map<string, string[]>();
    const queue: [string, string[]][] = references(file, text).map(node => [node, [node]]);
    while (queue.length > 0) {
        const [node, trail] = queue.shift()!;
        if (paths.has(node)) continue;
        paths.set(node, trail);
        if (BOUNDARY.has(node)) continue;
        const body = unitOf(node);
        if (body === undefined) continue; // a type, a class, or a value of no code
        const [owner] = node.split('#') as [string, string];
        for (const next of references(owner, body)) if (!paths.has(next)) queue.push([next, [...trail, next]]);
    }
    return paths;
}

/** The text of a node (`file#name`), or undefined for a type, a class or a value of no code. */
export function unitOf(node: string): string | undefined {
    const [owner, name] = node.split('#') as [string, string];
    return graphOf(owner).units.get(name);
}

/** A member of host.ts's element class. */
export const member = (name: string) => graphOf('src/host.ts').units.get(`this.${name}`)!;
