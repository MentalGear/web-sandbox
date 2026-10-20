import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processFile, signatureOf, type Item, type Plugin } from '../../tools/docgen/engine';
import { run } from '../../tools/docgen/run';

/**
 * The docs generator's engine (tools/docgen/engine.ts) on fixtures: it knows nothing of this repository, so a plugin
 * of two colours and a counter stands in for the extractors.
 */

const colour = (id: string, hex: string): Item => ({ id: `colour:${id}`, signature: signatureOf({ hex }), render: () => `- ${id}: ${hex}` });
let colours = [colour('red', '#f00'), colour('blue', '#00f')];
let counter = 1;

const plugin = (): Plugin => ({
    extractors: { colours: () => colours },
    regions: { counter: () => `count: ${counter}\n` },
    describes: () => [{ id: 'counter', signature: signatureOf({ counter }), render: () => '' }],
});

const REGION = '<!-- generated:begin colours -->\n- stale\n<!-- generated:end -->';
const DOC = ['# Title', '', 'Prose before.', '', REGION, '', 'Prose after, with `code` and a | pipe.', ''].join('\n');
const MARKED = ['# Doc', '', '## Palette', '<!-- describes: colour:red, colour:blue -->', 'The palette is red and blue.', ''].join('\n');

const handle = (text: string, mode: 'write' | 'check' | 'accept' = 'write') => processFile('doc.md', text, plugin(), mode);
const kinds = (text: string, mode: 'write' | 'check' | 'accept' = 'check') => handle(text, mode).problems.map(problem => problem.kind);

afterEach(() => { colours = [colour('red', '#f00'), colour('blue', '#00f')]; counter = 1; });

describe('regions', () => {
    it('are rewritten from the extractor named in the begin line, and nothing outside them changes', () => {
        const { text, problems } = handle(DOC);
        expect(text).toBe(DOC.replace('- stale', '- red: #f00\n- blue: #00f'));
        expect(problems.map(problem => problem.kind)).toEqual(['region-differs']);
        expect(text.split('\n').filter(line => !/^(- |<!--)/.test(line))).toEqual(DOC.split('\n').filter(line => !/^(- |<!--)/.test(line)));
    });

    it('are idempotent: a second run changes nothing and finds no difference', () => {
        const once = handle(DOC).text;
        const again = handle(once);
        expect(again.text).toBe(once);
        expect(again.problems).toEqual([]);
    });

    it('are reported by check, which writes nothing', () => {
        const checked = handle(DOC, 'check');
        expect(checked.text).toBe(DOC);
        expect(checked.problems).toHaveLength(1);
        expect(checked.problems[0]).toMatchObject({ kind: 'region-differs', file: 'doc.md', line: 5 });
        expect(kinds(handle(DOC).text)).toEqual([]);
    });

    it('take a renderer that is not a list of items, and an empty rendering empties the region', () => {
        const text = '<!-- generated:begin counter -->\nold\n<!-- generated:end -->\n';
        expect(handle(text).text).toBe('<!-- generated:begin counter -->\ncount: 1\n<!-- generated:end -->\n');
        const empty: Plugin = { extractors: { colours: () => [] } };
        expect(processFile('doc.md', REGION, empty, 'write').text).toBe('<!-- generated:begin colours -->\n<!-- generated:end -->');
    });

    it('follow the value: a changed item changes the region', () => {
        const before = handle(REGION).text;
        colours = [colour('red', '#e00'), colour('blue', '#00f')];
        expect(kinds(before)).toEqual(['region-differs']);
        expect(handle(before).text).toContain('- red: #e00');
    });

    it('with a name no extractor has are reported and left as they are', () => {
        const text = '<!-- generated:begin nothing -->\nkept\n<!-- generated:end -->';
        for (const mode of ['write', 'check', 'accept'] as const) {
            const result = handle(text, mode);
            expect(result.problems.map(problem => problem.kind)).toEqual(['unknown-region']);
            expect(result.text).toBe(text);
        }
    });

    it('left unterminated are reported, and so is an end that closes nothing; the text is not touched', () => {
        const open = ['a', '<!-- generated:begin colours -->', 'kept', '', '<!-- generated:begin counter -->', 'kept too', '<!-- generated:end -->', 'b'].join('\n');
        const result = handle(open);
        expect(result.problems.map(problem => problem.kind)).toEqual(['unterminated-region', 'region-differs']);
        expect(result.text).toContain('kept\n');
        expect(result.text).toContain('count: 1');
        expect(kinds('<!-- generated:begin colours -->\nkept')).toEqual(['unterminated-region']);
        expect(handle('<!-- generated:begin colours -->\nkept').text).toBe('<!-- generated:begin colours -->\nkept');
        expect(kinds('text\n<!-- generated:end -->\n')).toEqual(['stray-end']);
    });

    it('are not read inside a fenced code block, where a doc shows the syntax', () => {
        const text = ['```md', '<!-- generated:begin nothing -->', '<!-- describes: nothing sig:0000 -->', '```', ''].join('\n');
        expect(handle(text)).toEqual({ text, problems: [] });
    });
});

describe('markers', () => {
    it('are unsigned until accepted, then hold: formatting of the doc around them changes nothing', () => {
        expect(kinds(MARKED)).toEqual(['unsigned-marker']);
        const accepted = handle(MARKED, 'accept');
        expect(accepted.text).toMatch(/<!-- describes: colour:red, colour:blue sig:[0-9a-f]{8} -->/);
        expect(kinds(accepted.text)).toEqual([]);
        expect(kinds(accepted.text.replace('The palette is red and blue.', 'Reworded prose, rewrapped.\n\n\n'))).toEqual([]);
    });

    it('fail when an item changes, naming the section and only the changed item', () => {
        const accepted = handle(MARKED, 'accept').text;
        colours = [colour('red', '#f00'), colour('blue', '#00a')];
        const { problems } = handle(accepted);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatchObject({ kind: 'stale-marker', line: 4 });
        expect(problems[0]!.message).toContain('"Palette"');
        expect(problems[0]!.message).toContain('colour:blue');
        expect(problems[0]!.message).not.toContain('colour:red');
    });

    it('fail when an item is added to the marker, or removed from the code', () => {
        const accepted = handle(MARKED, 'accept').text;
        expect(kinds(accepted.replace('colour:blue', 'colour:blue, counter'))).toEqual(['stale-marker']);
        colours = [colour('red', '#f00')];
        expect(kinds(accepted)).toEqual(['unknown-item']);
    });

    it('are rewritten by accept only, with the text around them untouched; write and check leave the digits', () => {
        const accepted = handle(MARKED, 'accept').text;
        counter = 2;
        const marked = `${accepted}\n<!-- describes: counter -->\n`;
        const signed = handle(marked, 'accept').text;
        expect(signed).toMatch(/<!-- describes: counter sig:[0-9a-f]{4} -->/);
        expect(signed.replace(/ sig:[0-9a-f]+/g, '')).toBe(marked.replace(/ sig:[0-9a-f]+/g, ''));
        counter = 3;
        expect(handle(signed, 'write').text).toBe(signed);
        expect(handle(signed, 'check').text).toBe(signed);
        expect(kinds(signed)).toEqual(['stale-marker']);
        expect(kinds(handle(signed, 'accept').text)).toEqual([]);
    });

    it('with an item no extractor has, or no item at all, are reported', () => {
        expect(kinds('<!-- describes: colour:green sig:0000 -->')).toEqual(['unknown-item']);
        expect(kinds('<!-- describes:  sig:0000 -->')).toEqual(['bad-marker']);
        expect(kinds('<!-- describes: colour:red sig -->')).toEqual(['unknown-item']);
    });

    it('hash the signature, which is the value and never its formatting', () => {
        expect(signatureOf({ b: [2, { y: 1, x: 2 }], a: 'text' })).toBe(signatureOf({ a: 'text', b: [2, { x: 2, y: 1 }] }));
        expect(signatureOf({ a: 1 })).not.toBe(signatureOf({ a: 2 }));
    });

    it('cannot name one item twice across extractors', () => {
        const twice: Plugin = { extractors: { a: () => [colour('red', '#f00')], b: () => [colour('red', '#f00')] } };
        expect(() => processFile('doc.md', '', twice, 'check')).toThrow(/two items are called colour:red/);
    });
});

describe('the command line over a directory', () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
    const tree = (files: Record<string, string>) => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'docgen-'));
        roots.push(root);
        for (const [file, text] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            writeFileSync(path.join(root, file), text);
        }
        return root;
    };
    const quiet = () => {};

    it('writes in the default mode, fails in --check on any difference, and --accept signs the markers', () => {
        const root = tree({ 'README.md': DOC, 'docs/guide.md': MARKED, 'docs/plain.md': 'no markers', 'node_modules/x/y.md': REGION });
        expect(run(root, plugin(), ['--check'], quiet).exitCode).toBe(1);
        expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(DOC);

        const written = run(root, plugin(), [], quiet);
        expect(written.written).toEqual(['README.md']);
        expect(written.exitCode).toBe(0); // a marker to review does not fail the writer
        expect(readFileSync(path.join(root, 'node_modules/x/y.md'), 'utf8')).toBe(REGION);
        expect(run(root, plugin(), ['--check'], quiet).problems.map(problem => problem.kind)).toEqual(['unsigned-marker']);

        expect(run(root, plugin(), ['--accept'], quiet).written).toEqual(['docs/guide.md']);
        const clean = run(root, plugin(), ['--check'], quiet);
        expect(clean).toMatchObject({ exitCode: 0, problems: [], written: [] });

        counter = 2;
        colours = [colour('red', '#f01'), colour('blue', '#00f')];
        const lines: string[] = [];
        expect(run(root, plugin(), ['--check'], line => lines.push(line)).exitCode).toBe(1);
        expect(lines.join('\n')).toContain('docs/guide.md:4: stale-marker: section "Palette" describes items that changed: colour:red');
        expect(lines.join('\n')).toContain('README.md:5: region-differs');
    });

    it('fails the writer on a structural mistake', () => {
        const root = tree({ 'a.md': '<!-- generated:begin nothing -->\n<!-- generated:end -->\n' });
        expect(run(root, plugin(), [], quiet).exitCode).toBe(1);
    });
});
