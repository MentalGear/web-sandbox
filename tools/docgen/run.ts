/**
 * The docs generator's command line, for any repository: it walks the Markdown files under a root and runs the engine
 * on each in the mode the arguments name.
 *
 *   (no flag)  rewrite the regions; list the markers that need review
 *   --check    write nothing; fail on a region that differs, a stale or unsigned marker, or a structural mistake
 *   --accept   rewrite the regions and write the markers' digests (read the sections first)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { indexItems, processFile, STRUCTURAL, type Mode, type Plugin, type Problem } from './engine';

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'temp', 'coverage', 'playwright-report', 'test-results', 'out']);

/** The Markdown files under `root`, as paths relative to it. A directory that starts with a dot is skipped. */
export function markdownFiles(root: string, directory = ''): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) files.push(...markdownFiles(root, relative));
        } else if (entry.name.endsWith('.md')) files.push(relative);
    }
    return files.sort();
}

export interface RunResult {
    readonly exitCode: number;
    readonly problems: readonly Problem[];
    /** The files written. */
    readonly written: readonly string[];
}

/** Runs the generator over `root`; `argv` is the command line's flags. Prints the problems to `log`. */
export function run(root: string, plugin: Plugin, argv: readonly string[], log: (line: string) => void = console.log): RunResult {
    const mode: Mode = argv.includes('--check') ? 'check' : argv.includes('--accept') ? 'accept' : 'write';
    const items = indexItems(plugin);
    const problems: Problem[] = [];
    const written: string[] = [];
    for (const file of markdownFiles(root)) {
        const text = readFileSync(path.join(root, file), 'utf8');
        if (!text.includes('<!-- generated:') && !text.includes('<!-- describes:')) continue;
        const result = processFile(file, text, plugin, mode, items);
        problems.push(...result.problems);
        if (mode !== 'check' && result.text !== text) {
            writeFileSync(path.join(root, file), result.text);
            written.push(file);
        }
    }
    // a region that differs is reported when nothing is written; when it is written, the file is
    const reported = mode === 'check' ? problems : problems.filter(problem => problem.kind !== 'region-differs');
    for (const problem of reported) log(`${problem.file}:${problem.line}: ${problem.kind}: ${problem.message}`);
    for (const file of written) log(`wrote ${file}`);
    const failing = mode === 'check' ? problems : problems.filter(problem => STRUCTURAL.includes(problem.kind));
    if (mode === 'check' && problems.length > 0) log('docs are out of date: bun run docs:gen rewrites the regions; a stale marker is accepted with bun run docs:gen --accept once its section is read');
    else if (mode === 'write' && problems.some(problem => problem.kind === 'stale-marker' || problem.kind === 'unsigned-marker')) log('markers above need review: read the section, then bun run docs:gen --accept');
    return { exitCode: failing.length > 0 ? 1 : 0, problems, written };
}
