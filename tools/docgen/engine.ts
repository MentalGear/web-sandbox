/**
 * The docs generator's engine. It knows nothing about the repository it runs in: a plugin supplies the extractors.
 *
 * Two things in a Markdown file are the engine's:
 *  - a region, `<!-- generated:begin NAME -->` … `<!-- generated:end -->`, each on a line of its own: the lines between
 *    are rewritten from the extractor named NAME. Nothing outside a region is ever touched.
 *  - a marker, `<!-- describes: ID, ID sig:HASH -->`, before a handwritten section: the items the section describes. HASH
 *    holds 4 hex digits per item, in the order written, from the item's ID and semantic signature (names, types, values,
 *    transitions; an extractor never puts formatting in a signature). A marker fails when an item's signature no longer
 *    hashes to its digits; the failure names the section and the items, and `accept` writes the new digits once the
 *    section has been read.
 *
 * Fenced code blocks outside regions are skipped, so a doc can show the syntax.
 */
import { createHash } from 'node:crypto';

/** One thing a doc can describe: an ID, a signature that changes when its meaning does, and its rendering for a region. */
export interface Item {
    readonly id: string;
    readonly signature: string;
    render(): string;
}

export interface Plugin {
    /** Item lists by name. Region NAME renders its list, one item after another, unless `regions` has the name. */
    readonly extractors: Readonly<Record<string, () => readonly Item[]>>;
    /** Region renderers that are not lists of items. */
    readonly regions?: Readonly<Record<string, () => string>>;
    /** Items only markers refer to (no rendering of their own). */
    readonly describes?: () => readonly Item[];
}

/** `write` rewrites regions; `check` changes nothing and reports; `accept` also writes the markers' digests. */
export type Mode = 'write' | 'check' | 'accept';

export type ProblemKind =
    | 'region-differs' | 'unknown-region' | 'unterminated-region' | 'stray-end'
    | 'stale-marker' | 'unknown-item' | 'unsigned-marker' | 'bad-marker';

export interface Problem {
    readonly kind: ProblemKind;
    readonly file: string;
    readonly line: number;
    readonly message: string;
}

/** Problems that leave a file unusable as it stands: the writer reports them and stops. The rest are about review. */
export const STRUCTURAL: readonly ProblemKind[] = ['unknown-region', 'unterminated-region', 'stray-end', 'unknown-item', 'bad-marker'];

/** A value's signature: JSON with the keys of every object sorted, so the order a value was written in never matters. */
export function signatureOf(value: unknown): string {
    const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
        : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sort(x)]))
        : v;
    return JSON.stringify(sort(value));
}

const digest = (item: { id: string; signature: string }) => createHash('sha256').update(`${item.id}\n${item.signature}`).digest('hex').slice(0, 4);

const BEGIN = /^<!-- generated:begin ([\w:.-]+) -->$/;
const END = '<!-- generated:end -->';
const DESCRIBES = /^<!-- describes: ([^>]*?)(?: sig:([0-9a-f]*))? -->$/;
const FENCE = /^\s*(```|~~~)/;

/** Every item the plugin knows, by ID; two with one ID is a mistake of the plugin's. */
export function indexItems(plugin: Plugin): Map<string, Item> {
    const items = new Map<string, Item>();
    for (const item of [...Object.values(plugin.extractors).flatMap(extract => extract()), ...(plugin.describes?.() ?? [])]) {
        if (items.has(item.id)) throw new Error(`docgen: two items are called ${item.id}`);
        items.set(item.id, item);
    }
    return items;
}

/** The text of the region `name`, or undefined for a name the plugin has no extractor for. */
function renderRegion(plugin: Plugin, name: string): string | undefined {
    const renderer = plugin.regions?.[name];
    if (renderer) return renderer();
    const extract = plugin.extractors[name];
    return extract && extract().map(item => item.render()).join('\n');
}

/** Processes one Markdown file: its regions rewritten (unless `check`), its markers checked (and signed, if `accept`). */
export function processFile(file: string, text: string, plugin: Plugin, mode: Mode, items = indexItems(plugin)): { text: string; problems: Problem[] } {
    const lines = text.split('\n');
    const out: string[] = [];
    const problems: Problem[] = [];
    const problem = (kind: ProblemKind, line: number, message: string) => problems.push({ kind, file, line, message });
    let fence = false;
    let heading = '(before the first heading)';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trimEnd();
        if (FENCE.test(line)) fence = !fence;
        if (fence || FENCE.test(line)) { out.push(line); continue; }
        const title = /^#{1,6}\s+(.*?)\s*$/.exec(line);
        if (title) heading = title[1]!.replace(/<a [^>]*><\/a>/g, '').replace(/`/g, '');
        const begin = BEGIN.exec(trimmed);
        if (begin) {
            const name = begin[1]!;
            let end = -1;
            for (let j = i + 1; j < lines.length && end < 0; j++) {
                if (lines[j]!.trimEnd() === END) end = j;
                else if (BEGIN.test(lines[j]!.trimEnd())) break;
            }
            const rendered = renderRegion(plugin, name);
            if (end < 0) problem('unterminated-region', i + 1, `region "${name}" has no "${END}" before the next region or the end of the file`);
            else if (rendered === undefined) problem('unknown-region', i + 1, `no extractor is called "${name}"`);
            if (end < 0 || rendered === undefined) {
                out.push(line, ...(end < 0 ? [] : lines.slice(i + 1, end + 1)));
                i = end < 0 ? i : end;
                continue;
            }
            const body = rendered.replace(/\n+$/, '').split('\n');
            const current = lines.slice(i + 1, end);
            if (rendered === '' ? current.length > 0 : body.join('\n') !== current.join('\n')) {
                problem('region-differs', i + 1, `region "${name}" is not what its extractor renders`);
                out.push(line, ...(mode === 'check' ? current : rendered === '' ? [] : body));
            } else out.push(line, ...current);
            out.push(lines[end]!);
            i = end;
            continue;
        }
        if (trimmed === END) { problem('stray-end', i + 1, `"${END}" closes no region`); out.push(line); continue; }
        const marker = trimmed.startsWith('<!-- describes:') ? DESCRIBES.exec(trimmed) : null;
        if (trimmed.startsWith('<!-- describes:') && !marker) { problem('bad-marker', i + 1, 'a marker reads "<!-- describes: ID, ID sig:HASH -->"'); out.push(line); continue; }
        if (!marker) { out.push(line); continue; }
        const ids = marker[1]!.split(',').map(id => id.trim()).filter(Boolean);
        const unknown = ids.filter(id => !items.has(id));
        if (ids.length === 0 || unknown.length > 0) {
            problem(ids.length === 0 ? 'bad-marker' : 'unknown-item', i + 1, `section "${heading}" describes ${ids.length === 0 ? 'nothing' : `unknown items: ${unknown.join(', ')}`}`);
            out.push(line);
            continue;
        }
        const now = ids.map(id => digest(items.get(id)!));
        const recorded = marker[2];
        const changed = ids.filter((_, index) => recorded?.slice(index * 4, index * 4 + 4) !== now[index]);
        if (recorded === undefined) problem('unsigned-marker', i + 1, `section "${heading}" has a marker with no sig; review it, then accept`);
        else if (changed.length > 0) {
            problem('stale-marker', i + 1, `section "${heading}" describes items that changed: ${(recorded.length === now.join('').length ? changed : ids).join(', ')}`);
        }
        out.push(mode === 'accept' ? `<!-- describes: ${ids.join(', ')} sig:${now.join('')} -->` : line);
    }
    return { text: out.join('\n'), problems };
}
