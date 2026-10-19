import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADRS, ID_CITATION, PREFIXED_SOURCES, resolveId } from '../../docs/ids';
import { comments, SyntaxKind, tokenize } from '../../scripts/js-tokens';

/**
 * Every link between the docs resolves, and so does every stable ID (docs/ids.ts) cited in the code and the docs
 * (CONTRIBUTING.md, "Code and docs: the current state"). A renamed heading, a moved file or an ID that names no row
 * fails here, with the file and line that cite it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

// The repository's files, tracked or new (not ignored), so a file added in the change under test is checked too.
const FILES = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(file => file && existsSync(path.join(ROOT, file)));
const MARKDOWN = FILES.filter(file => file.endsWith('.md'));

/** GitHub's anchor for a heading: lower case, tags and punctuation removed, each space a hyphen. */
export function headingSlug(heading: string): string {
    return heading.replace(/<[^>]*>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim().toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** The lines of a Markdown text outside fenced code blocks, with their numbers. */
function proseLines(text: string): { line: string; number: number }[] {
    const out: { line: string; number: number }[] = [];
    let fence = false;
    text.split('\n').forEach((line, index) => {
        if (/^\s*(```|~~~)/.test(line)) fence = !fence;
        else if (!fence) out.push({ line, number: index + 1 });
    });
    return out;
}

const anchorCache = new Map<string, Set<string>>();
/** The anchors of a Markdown file: its headings' slugs (repeats numbered as GitHub numbers them) and its HTML anchors. */
function anchorsOf(file: string): Set<string> {
    let anchors = anchorCache.get(file);
    if (anchors) return anchors;
    anchors = new Set();
    const repeats = new Map<string, number>();
    for (const { line } of proseLines(read(file))) {
        for (const match of line.matchAll(/<a (?:id|name)="([^"]+)"/g)) anchors.add(match[1]!);
        const heading = /^#{1,6} (.*)$/.exec(line);
        if (!heading) continue;
        const slug = headingSlug(heading[1]!.replace(/`/g, ''));
        const seen = repeats.get(slug) ?? 0;
        repeats.set(slug, seen + 1);
        anchors.add(seen ? `${slug}-${seen}` : slug);
    }
    anchorCache.set(file, anchors);
    return anchors;
}

interface Link { from: string; line: number; target: string }

/** The relative links of a Markdown file (inline links, images and reference definitions), outside code. */
function linksOf(file: string): Link[] {
    const links: Link[] = [];
    for (const { line, number } of proseLines(read(file))) {
        const text = line.replace(/`[^`]*`/g, '');
        const targets = [
            ...[...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(match => match[1]!),
            ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/g)].map(match => match[1]!),
        ];
        for (const target of targets) {
            if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:, data:
            links.push({ from: file, line: number, target });
        }
    }
    return links;
}

/** Where a link leads: the repository path of its file (the linking file itself for `#anchor`) and its anchor. */
function destination(link: Link): { file: string; anchor: string | undefined } {
    const hash = link.target.indexOf('#');
    const filePart = hash < 0 ? link.target : link.target.slice(0, hash);
    const anchor = hash < 0 ? undefined : decodeURIComponent(link.target.slice(hash + 1));
    const file = filePart ? path.posix.normalize(path.posix.join(path.posix.dirname(link.from), decodeURI(filePart))) : link.from;
    return { file: file.replace(/\/$/, ''), anchor };
}

/** Why a link or an ID's target does not resolve, or undefined when it does. */
function unresolved(file: string, anchor: string | undefined): string | undefined {
    const full = path.join(ROOT, file);
    if (!existsSync(full)) return `no file ${file}`;
    if (anchor === undefined || !file.endsWith('.md') || !statSync(full).isFile()) return undefined;
    return anchorsOf(file).has(anchor) ? undefined : `no anchor #${anchor} in ${file}`;
}

// The docs no other doc links to (the root README is the entry point). Listed so that a new one is a decision: link it
// from where a reader looks for it. Step 3 of S76 (the archive) decides these.
const UNLINKED = [
    'docs/README.md',
    'docs/Sandbox_Architecture_Decision.md',
    'docs/research/DEVTOOLS_SECURITY.md',
    'docs/research/LOCAL_FIRST_ARCH.md',
    'docs/research/VFS_ARCHITECTURE.md',
    'docs/research/VIRTUAL_FILES_PLAN.md',
    'docs/research/Virtual-Files-Security-Architecture.md',
];

describe('the links between the docs', () => {
    const links = MARKDOWN.flatMap(linksOf);

    it('every relative link names a file that exists, and an anchor that file has', () => {
        expect(links.length).toBeGreaterThan(500);
        const broken = links.flatMap(link => {
            const { file, anchor } = destination(link);
            const why = unresolved(file, anchor);
            return why ? [`${link.from}:${link.line} ${link.target}: ${why}`] : [];
        });
        expect(broken).toEqual([]);
    });

    it('every doc is linked from another one, but the listed ones', () => {
        const linked = new Set(links.map(destination).map(({ file }) => file).filter((file, index) => file !== links[index]!.from));
        const unlinked = MARKDOWN.filter(file => file !== 'README.md' && !linked.has(file));
        expect(unlinked.sort()).toEqual([...UNLINKED].sort());
    });

    it('the slugs are GitHub\'s', () => {
        expect(headingSlug('`sandboxView` (strict mode)'.replace(/`/g, ''))).toBe('sandboxview-strict-mode');
        expect(headingSlug('<a id="s76"></a>S76 · Self-explaining code')).toBe('s76--self-explaining-code');
        expect(headingSlug('(a) The long-run bound')).toBe('a-the-long-run-bound');
    });
});

/** The texts of a file where an ID can be cited: a code file's comments and strings, all of a doc. */
function citingTexts(file: string): { text: string; offset: number }[] {
    const text = read(file);
    if (!/\.(ts|mjs|js)$/.test(file)) return [{ text, offset: 0 }];
    const strings = tokenize(text).filter(token => token.kind === SyntaxKind.StringLiteral || token.kind === SyntaxKind.NoSubstitutionTemplateLiteral
        || token.kind === SyntaxKind.TemplateHead || token.kind === SyntaxKind.TemplateMiddle || token.kind === SyntaxKind.TemplateTail);
    return [...comments(text), ...strings].map(token => ({ text: token.text, offset: token.start }));
}

describe('the stable IDs', () => {
    const citing = FILES.filter(file => /^(src|test|docs)\//.test(file) && /\.(ts|mjs|js|md)$/.test(file) || /^[^/]+\.md$/.test(file));

    it('every ID cited in src/, test/ and the docs resolves to a file and an anchor in it', () => {
        const broken: string[] = [];
        let cited = 0;
        for (const file of citing) {
            const whole = read(file);
            for (const { text, offset } of citingTexts(file)) {
                for (const match of text.matchAll(ID_CITATION)) {
                    cited++;
                    const target = resolveId(match[0]);
                    const why = target ? unresolved(target.file, target.anchor) : 'no such source';
                    if (why) broken.push(`${file}:${whole.slice(0, offset + match.index).split('\n').length} ${match[0]}: ${why}`);
                }
            }
        }
        expect(cited).toBeGreaterThan(400);
        expect(broken).toEqual([]);
    });

    it('every source in the registry exists, and every ADR is in it', () => {
        for (const source of PREFIXED_SOURCES) expect(existsSync(path.join(ROOT, source.file)), source.file).toBe(true);
        const adrs = FILES.filter(file => /^docs\/ADR-\d{3}-[^/]+\.md$/.test(file)).sort();
        expect(Object.values(ADRS).sort()).toEqual(adrs);
    });

    it('each source\'s example resolves, and CONTRIBUTING.md states the scheme', () => {
        const contributing = read('CONTRIBUTING.md');
        for (const source of PREFIXED_SOURCES) {
            const target = resolveId(source.example)!;
            expect(unresolved(target.file, target.anchor), source.example).toBeUndefined();
            expect(contributing, source.prefix).toContain(`\`${source.prefix}:`);
        }
    });
});
