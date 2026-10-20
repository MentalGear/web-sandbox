/**
 * ARCHITECTURE.md's module map: each file of src/ with the role its header comment gives. The only extractor that reads
 * source text: a module's role is prose, and its header comment is where the code keeps it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { signatureOf, type Item } from '../engine';
import { code, row, table, type Extractor } from './markdown';

const ROOT = path.resolve(import.meta.dirname, '../../..');

/** A parenthesis that cites a decision, item or finding: the role is said without it. */
const CITATION = /\s*\([^()]*\b(?:S\d+|T\d+|ADR-\d+|backlog|review|class [A-Z]|PR\d)\b[^()]*\)/g;

/** The files of `src/` that are modules (no tests), relative to the repository, sorted with the top level first. */
export function moduleFiles(directory = 'src'): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) files.push(...moduleFiles(relative));
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(relative);
    }
    return files.sort((a, b) => (a.split('/').length - b.split('/').length) || a.localeCompare(b));
}

/**
 * The role a file's header comment gives: its first sentence. The header is the comment that opens the file or, in a
 * file that opens with imports, the first comment after them (a one-line license banner, `/*!`, is skipped). Undefined
 * for a file that has none.
 */
export function headerSentence(source: string): string | undefined {
    const lines = source.split('\n');
    let index = 0;
    for (; index < lines.length; index++) {
        if (/^\s*$/.test(lines[index]!) || /^\/\*!.*\*\/\s*$/.test(lines[index]!)) continue;
        if (!/^import\b/.test(lines[index]!)) break;
        while (index < lines.length && !/(\bfrom\s+|^import\s+)['"][^'"]+['"];?\s*$/.test(lines[index]!)) index++;
    }
    const text: string[] = [];
    if (lines[index]?.startsWith('/**')) {
        for (; index < lines.length; index++) {
            const line = lines[index]!;
            text.push(line.replace(/^\s*(\/\*\*|\*\/|\*)\s?/, '').replace(/\s*\*\/\s*$/, ''));
            if (line.includes('*/')) break;
        }
    } else if (lines[index]?.startsWith('//')) {
        for (; index < lines.length && lines[index]!.startsWith('//'); index++) text.push(lines[index]!.replace(/^\/\/\s?/, ''));
    } else return undefined;
    const paragraph = text.join('\n').trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, ' ').replace(CITATION, '');
    const sentence = /^(.*?)(?:\.(?:\s|$)|$)/.exec(paragraph)![1]!.replace(/:$/, '').trim();
    // a long sentence is cut at its first colon: what follows says how, and the table says what
    const role = sentence.length > 120 ? (/^(.{12,}?):/.exec(sentence)?.[1] ?? sentence) : sentence;
    return role || undefined;
}

const summaries = () => moduleFiles().map(file => ({ file, role: headerSentence(readFileSync(path.join(ROOT, file), 'utf8')) }));

const items = (): Item[] => summaries().map(({ file, role }) => ({
    id: `module:${file}`,
    signature: signatureOf({ role }),
    render: () => row([code(file), role ?? '(no header comment)']),
}));

export const modules: Extractor = {
    items,
    regions: { 'module-map': () => table(['Module', 'Role'], items().map(item => item.render())) },
};
