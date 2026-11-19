import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORK_MODES_FLAG } from '@src/lib/build-flag';
import { VIEW_STILL_STYLE } from '@src/lib/in-sandbox-view';
import { HASHED_TEXTS, POLICY_DIRECTIVES, type PolicyDirectiveRow, renderSealedDocument, SEALED_DOCUMENT_FILE, SEALED_DOCUMENT_GUARD, SEALED_VIEW_FLAGS, sealedDocument, sealedDocumentPolicy, sealedViewBootstrap } from '@src/lib/sealed-document';

/**
 * Sealed mode's served document, `sealed-document.html` (design 03, "Inside the file"; step 3.1 of design 05):
 *
 *  - I13, a source scan: F has one script, the guard, and nothing in F handles a message; C, in F's static markup, holds
 *    one script, sealed mode's view bootstrap. The scan fails for a file with a second script in F or C, a listener or a
 *    handler attribute in F, or a view with the host's origin.
 *  - The policy: the hashes in the `<meta>` are the hashes of the scripts and the stylesheet the file holds, computed here
 *    with another SHA-256 than the library's; its directives are POLICY_DIRECTIVES, with no source an input could add.
 *  - I12, no input: the generator takes none and reads nothing of its environment, both builds' sources give the same
 *    bytes (in two processes, one with the network modes installed), and the two built files are byte for byte the same.
 *    Another bootstrap gives other bytes, so a build whose text differed would fail the comparison.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILE = sealedDocument();

const sha = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const elementsOf = (doc: Document) => [...doc.querySelectorAll('*')];

/** What the file holds, read as a browser's parser reads it: F, C's frame, C's document, F's policy. */
function readFile(html: string) {
    const f = parse(html);
    const frames = [...f.querySelectorAll('iframe')];
    const c = parse(frames[0]?.getAttribute('srcdoc') ?? '');
    const metas = [...f.querySelectorAll('meta[http-equiv]')].filter(meta => meta.getAttribute('http-equiv')!.toLowerCase() === 'content-security-policy');
    return { f, frames, c, policy: metas.map(meta => meta.getAttribute('content') ?? '') };
}

/** The elements a document may hold, by its role: anything else is a load, a script or markup the file does not have. */
const F_ELEMENTS = ['html', 'head', 'meta', 'base', 'script', 'body', 'iframe'];
const C_ELEMENTS = ['html', 'head', 'script', 'body'];
// What a script that handles a message has: a listener, a handler property, or a post onward (a relay).
const LISTENS = /addEventListener|\bon\w+\s*=|onmessage|postMessage|MessageChannel/;

/** I13's scan: every way the file is not one guard in F and one bootstrap in C, with nothing in F that listens. */
function scanViolations(html: string): string[] {
    const found: string[] = [];
    const { f, frames, c } = readFile(html);
    const rawScripts = html.match(/<script\b/gi) ?? [];
    if (rawScripts.length !== 1) found.push(`F's text has ${rawScripts.length} script tags`);
    const fScripts = [...f.querySelectorAll('script')];
    if (fScripts.length !== 1) found.push(`F has ${fScripts.length} scripts`);
    for (const script of fScripts) {
        if (script.textContent !== SEALED_DOCUMENT_GUARD) found.push("a script of F's is not the guard");
        if (LISTENS.test(script.textContent ?? '')) found.push('a script of F handles messages');
        if (script.hasAttribute('src')) found.push('a script of F loads a URL');
    }
    if (frames.length !== 1) found.push(`F has ${frames.length} frames`);
    for (const element of elementsOf(f)) {
        if (!F_ELEMENTS.includes(element.localName)) found.push(`F holds a <${element.localName}>`);
        for (const name of element.getAttributeNames()) if (name.startsWith('on')) found.push(`F's <${element.localName}> has a handler attribute, ${name}`);
    }
    const view = frames[0];
    if (view) {
        const position = fScripts[0]?.compareDocumentPosition(view) ?? 0;
        if (!(position & Node.DOCUMENT_POSITION_FOLLOWING)) found.push('the guard does not come before C');
        if (view.getAttribute('sandbox') !== SEALED_VIEW_FLAGS.join(' ')) found.push(`C's sandbox attribute is ${JSON.stringify(view.getAttribute('sandbox'))}`);
        if (view.hasAttribute('src')) found.push('C loads a URL');
    }
    const cScripts = [...c.querySelectorAll('script')];
    if (cScripts.length !== 1) found.push(`C has ${cScripts.length} scripts`);
    for (const element of elementsOf(c)) {
        if (!C_ELEMENTS.includes(element.localName)) found.push(`C holds a <${element.localName}>`);
        for (const name of element.getAttributeNames()) found.push(`C's <${element.localName}> has an attribute, ${name}`);
    }
    return found;
}

/** The policy's directives, in order, with their sources. */
function directivesOf(policy: string): [string, string[]][] {
    const directives: [string, string[]][] = [];
    for (const part of policy.split(';')) {
        const [name, ...sources] = part.trim().split(/\s+/);
        directives.push([name!, sources]);
    }
    return directives;
}

/** The stylesheet the view's bootstrap inserts (the still sheet, in its options literal). */
function stillSheetOf(bootstrap: string): string {
    const literal = /"stillStyle":("(?:[^"\\]|\\.)*")/.exec(bootstrap);
    expect(literal, 'the bootstrap carries the still stylesheet').not.toBeNull();
    return JSON.parse(literal![1]!) as string;
}

/** Every hash of the policy that is not the hash of a text the file holds, and every text the file holds without one. */
function hashMismatches(html: string): string[] {
    const { f, c, policy } = readFile(html);
    const directives = new Map(directivesOf(policy[0] ?? ''));
    const hashes = (name: string) => new Set((directives.get(name) ?? []).filter(source => source.startsWith("'sha256-")));
    const scripts = [...f.querySelectorAll('script'), ...c.querySelectorAll('script')].map(script => script.textContent ?? '');
    const sheets = [...f.querySelectorAll('style'), ...c.querySelectorAll('style')].map(sheet => sheet.textContent ?? '');
    for (const script of c.querySelectorAll('script')) sheets.push(stillSheetOf(script.textContent ?? ''));
    const found: string[] = [];
    for (const [name, texts] of [['script-src', scripts], ['style-src', sheets]] as const) {
        const held = new Set(texts.map(sha));
        const listed = hashes(name);
        for (const hash of listed) if (!held.has(hash)) found.push(`${name} lists ${hash}, the hash of no text the file holds`);
        for (const hash of held) if (!listed.has(hash)) found.push(`${name} does not list ${hash}, a text the file holds`);
    }
    return found;
}

describe('I13: F has one script, the guard, and nothing in it handles a message', () => {
    it('the file scans clean: one guard in F before C, one bootstrap in C, no handler, no other element', () => {
        expect(scanViolations(FILE)).toEqual([]);
        const { f, c } = readFile(FILE);
        expect(f.querySelector('script')!.textContent).toBe(SEALED_DOCUMENT_GUARD);
        expect(c.querySelector('script')!.textContent).toBe(sealedViewBootstrap());
    });

    it('the guard is synchronous and listens for nothing: not opaque or top-level, it stops the document', () => {
        expect(SEALED_DOCUMENT_GUARD).toBe("'use strict';if (self.origin !== 'null' || top === self) window.stop();");
        expect(LISTENS.test(SEALED_DOCUMENT_GUARD)).toBe(false);
        expect(SEALED_DOCUMENT_GUARD).not.toMatch(/\bawait\b|\bthen\(|setTimeout|queueMicrotask|=>|function/);
    });

    it("C's attribute is the most the library grants a view: strict mode's view flags and the safe capabilities, never the host's origin", () => {
        expect(SEALED_VIEW_FLAGS).toEqual(['allow-scripts', 'allow-forms', 'allow-orientation-lock']);
        expect(SEALED_VIEW_FLAGS).not.toContain('allow-same-origin');
    });

    // The vulnerable forms: each fails the scan with its own finding.
    const relay = "addEventListener('message', (e) => parent.parent.postMessage(e.data, '*', e.ports));";
    const mutants: [string, string, string][] = [
        ['a second script in F', FILE.replace('</head>', '<script>void 0</script></head>'), 'F has 2 scripts'],
        ['a message listener in the guard', FILE.replace(`<script>${SEALED_DOCUMENT_GUARD}`, `<script>${SEALED_DOCUMENT_GUARD}${relay}`), 'a script of F handles messages'],
        ['a handler attribute in F', FILE.replace('<body ', '<body onmessage="void 0" '), "F's <body> has a handler attribute, onmessage"],
        ['a second script in C', FILE.replace('&lt;body&gt;&lt;/body&gt;&lt;/html&gt;"', '&lt;body&gt;&lt;script&gt;void 0&lt;/script&gt;&lt;/body&gt;&lt;/html&gt;"'), 'C has 2 scripts'],
        ['a second frame in F', FILE.replace('</body>', '<iframe srcdoc="x"></iframe></body>'), 'F has 2 frames'],
        ['a view with the host\'s origin', FILE.replace('sandbox="allow-scripts allow-forms allow-orientation-lock"', 'sandbox="allow-scripts allow-forms allow-orientation-lock allow-same-origin"'), "C's sandbox attribute is"],
        ['a script loaded into F', FILE.replace('</head>', '<link rel="preload" href="x.js"></head>'), 'F holds a <link>'],
    ];
    it.each(mutants)('the scan fails for %s', (_name, mutant, finding) => {
        expect(mutant).not.toBe(FILE);
        expect(scanViolations(mutant).join('\n')).toContain(finding);
    });
});

describe("the policy: the <meta>'s hashes are the file's own texts', and its directives are POLICY_DIRECTIVES", () => {
    it('F has one policy, before its script, and it is the constant text', () => {
        const { f, policy } = readFile(FILE);
        expect(policy).toEqual([sealedDocumentPolicy()]);
        const meta = f.querySelector('meta[http-equiv]')!;
        expect(meta.compareDocumentPosition(f.querySelector('script')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // the one element before it is the inert base URL C inherits: a <base> after it would be refused (base-uri 'none')
        expect(f.querySelector('base')!.getAttribute('href')).toBe('about:blank');
        expect(f.querySelector('base')!.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(f.querySelector('meta[name="referrer"]')!.getAttribute('content')).toBe('no-referrer');
    });

    it('every hash it lists is the hash of a script or stylesheet the file holds, and each of those is listed (computed here, not copied)', () => {
        expect(hashMismatches(FILE)).toEqual([]);
        const { policy } = readFile(FILE);
        const directives = new Map(directivesOf(policy[0]!));
        expect(directives.get('script-src')).toEqual([sha(SEALED_DOCUMENT_GUARD), sha(sealedViewBootstrap())]);
        expect(directives.get('style-src')).toEqual([sha(VIEW_STILL_STYLE), 'blob:']);
    });

    it('a stale hash fails: a view whose bootstrap changed under the same policy, and a policy with a hash of no text', () => {
        const changed = FILE.replace('&lt;script&gt;(function () {', '&lt;script&gt;(function  () {');
        expect(changed).not.toBe(FILE);
        expect(hashMismatches(changed).join('\n')).toMatch(/script-src lists 'sha256-[^']+', the hash of no text the file holds/);
        const listed = FILE.replace(sha(VIEW_STILL_STYLE), sha('p{color:red}'));
        expect(hashMismatches(listed).join('\n')).toContain(`style-src does not list ${sha(VIEW_STILL_STYLE)}`);
    });

    it('its directives are the rows of POLICY_DIRECTIVES, in order, and no source is one an input or a report could use', () => {
        const directives = directivesOf(sealedDocumentPolicy());
        expect(directives.map(([name]) => name)).toEqual(Object.keys(POLICY_DIRECTIVES));
        for (const [name, sources] of directives) {
            const row = POLICY_DIRECTIVES[name as keyof typeof POLICY_DIRECTIVES];
            expect(sources.length, name).toBe(Math.max(1, row.sources.length));
            for (const source of sources) expect(source, name).toMatch(/^(?:'none'|blob:|'sha256-[A-Za-z0-9+/]{43}=')$/);
        }
        expect(sealedDocumentPolicy()).not.toMatch(/unsafe|report-uri|report-to|'self'|\*|https?:|data:|nonce/);
        expect(new Map(directives).get('connect-src')).toEqual(["'none'"]);
        expect(new Map(directives).get('worker-src')).toEqual(['blob:']);
        // every text the policy admits by hash is named by a row, and a row names no other
        const named = new Set<string>();
        for (const row of Object.values(POLICY_DIRECTIVES) as readonly PolicyDirectiveRow[]) for (const source of row.sources) if (typeof source !== 'string') named.add(source.hash);
        expect([...named].sort()).toEqual([...HASHED_TEXTS].sort());
    });
});

describe('I12: the file has no input, and both builds write the same bytes', () => {
    it('the generator takes no argument and reads nothing of its environment: two calls give the same bytes', () => {
        expect(sealedDocument.length).toBe(0);
        expect(sealedDocumentPolicy.length).toBe(0);
        expect(sealedViewBootstrap.length).toBe(0);
        expect(sealedDocument()).toBe(FILE);
        const source = readFileSync(path.join(ROOT, 'src/lib/sealed-document.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
        expect(source).not.toMatch(/process\.|import\.meta|\bDate\b|Math\.random|getRandomValues|\blocation\b|(?<![\w-])document\.|globalThis|\bnavigator\b|\bfetch\(/);
        // the build script writes this text and no other, and gives the generator nothing
        const script = readFileSync(path.join(ROOT, 'scripts/build-lib.ts'), 'utf8');
        expect(script).toContain('const servedDocument = sealedDocument();');
        expect(script).toContain('writeFileSync(join(outdir, SEALED_DOCUMENT_FILE), servedDocument);');
    });

    it('another bootstrap gives other bytes: the comparison of two builds fails for a build whose text differs', () => {
        expect(renderSealedDocument(sealedViewBootstrap())).toBe(FILE);
        expect(renderSealedDocument(`${sealedViewBootstrap()};`)).not.toBe(FILE);
    });

    // In Bun, as the build script runs: the sources of each build, in a process of their own.
    const inBun = (entry: string) => {
        const run = spawnSync('bun', ['-e', `await import('./${entry}'); const d = await import('./src/lib/sealed-document.ts'); const v = await import('./src/lib/in-sandbox-view.ts'); console.log(JSON.stringify({ file: Bun.hash(d.sealedDocument()).toString(), element: v.viewBootstrapText() === d.sealedViewBootstrap() }))`], { cwd: ROOT, encoding: 'utf8' });
        expect(run.status, run.stderr).toBe(0);
        return JSON.parse(run.stdout) as { file: string; element: boolean };
    };

    it("the default build's sources and the network build's give the same file, though the network build's element runs another bootstrap", () => {
        const fromDefault = inBun('src/index.ts');
        const fromNetwork = inBun('src/network.ts');
        expect(fromNetwork.file).toBe(fromDefault.file);
        expect(fromDefault.element).toBe(true);
        expect(fromNetwork.element).toBe(false); // the positive control: the network modes were installed there
    }, 30_000);

    it('the two builds write the same file, which scans clean and whose view is the default bundle\'s own bootstrap', () => {
        const out = (build: string) => `temp/sealed-document-test/${build}`;
        const written = (build: 'default' | 'network') => {
            const env = { ...process.env };
            delete env[NETWORK_MODES_FLAG.env];
            if (build === 'network') env[NETWORK_MODES_FLAG.env] = NETWORK_MODES_FLAG.on;
            const built = spawnSync('bun', ['scripts/build-lib.ts', '--out', out(build)], { cwd: ROOT, env, encoding: 'utf8' });
            expect(built.status, built.stderr).toBe(0);
            expect(built.stdout).toContain(`${out(build)}/${SEALED_DOCUMENT_FILE}`);
            return readFileSync(path.join(ROOT, out(build), SEALED_DOCUMENT_FILE), 'utf8');
        };
        const fromDefault = written('default');
        const fromNetwork = written('network');
        expect(fromNetwork === fromDefault, 'the two builds wrote different files').toBe(true);
        expect(scanViolations(fromDefault)).toEqual([]);
        expect(hashMismatches(fromDefault)).toEqual([]);
        // the default bundle's element hashes its bootstrap as the file's policy admits C's
        const hash = spawnSync('bun', ['-e', `const b = await import('./${out('default')}/index.js'); console.log(b.viewScriptHash())`], { cwd: ROOT, encoding: 'utf8' });
        expect(hash.status, hash.stderr).toBe(0);
        expect(sha(readFile(fromDefault).c.querySelector('script')!.textContent!)).toBe(hash.stdout.trim());
        rmSync(path.join(ROOT, 'temp/sealed-document-test'), { recursive: true, force: true });
    }, 120_000);
});
