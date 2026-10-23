/**
 * What the engine-ledger scan reads (test/unit/engine-ledger.test.ts): the lines of a spec under test/e2e/ that branch
 * on the engine, and the ledger rows they cite.
 *
 * A line is an engine site when it compares `browserName` with something, looks something up by it, tests it with
 * `includes`, is a per-engine map (two or more of `chromium:`, `firefox:`, `webkit:` on a line, or one at the start of
 * one), lists one or two engines as strings in an array (a list of all three is not a difference), or is an `engines:` override of the directive matrix. Passing
 * `browserName` on as an argument (`inView(page, browserName, …)`) is not a site: the callee that compares it is.
 *
 * A site is cited when `ledger: <id>[, <id>]` is on its own line or on one of the WINDOW lines above it. The citation is
 * text, usually in a comment: it needs no tokenizer, and a comment inside a template string that holds guest code counts.
 */

/** How many lines above a site a citation may stand. */
export const WINDOW = 8;

export const ENGINE_SITE = new RegExp([
    String.raw`\bbrowserName\s*(?:===|!==|==|!=)`,
    String.raw`(?:===|!==|==|!=)\s*browserName\b`,
    String.raw`\[\s*browserName\b`,
    String.raw`\.includes\(\s*browserName\s*\)`,
    String.raw`\bengines\s*:`,
    String.raw`\[\s*'(?:chromium|firefox|webkit)'(?:\s*,\s*'(?:chromium|firefox|webkit)')?\s*\]`,
    String.raw`^\s*(?:chromium|firefox|webkit)\s*:`,
    String.raw`\b(?:chromium|firefox|webkit)\s*:[^,]*,\s*(?:chromium|firefox|webkit)\s*:`,
].join('|'));

const CITATION = /\bledger:\s*([a-z][a-z0-9-]*(?:\s*,\s*[a-z][a-z0-9-]*)*)/;

const isComment = (line: string) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

export interface EngineSite {
    /** 1-based. */
    readonly line: number;
    readonly text: string;
    /** The ids cited at this site (on its line or the WINDOW lines above). */
    readonly cited: readonly string[];
}

/** The ids a line cites. */
export function citedIn(line: string): string[] {
    const found = CITATION.exec(line);
    return found ? found[1]!.split(',').map(id => id.trim()) : [];
}

/** Every ledger id a source text cites, anywhere. */
export function citedAnywhere(source: string): Set<string> {
    return new Set(source.split('\n').flatMap(citedIn));
}

/** The engine sites of a source text, each with the ids it cites. */
export function engineSites(source: string): EngineSite[] {
    const lines = source.split('\n');
    const sites: EngineSite[] = [];
    lines.forEach((text, index) => {
        if (isComment(text) || !ENGINE_SITE.test(text)) return;
        const cited = lines.slice(Math.max(0, index - WINDOW), index + 1).flatMap(citedIn);
        sites.push({ line: index + 1, text: text.trim(), cited });
    });
    return sites;
}

/** The sites that cite no row, or a row that is not in `known`: what the test reports, `file:line: text`. */
export function unledgered(file: string, source: string, known: ReadonlySet<string>): string[] {
    return engineSites(source).flatMap(site => {
        if (site.cited.length === 0) return [`${file}:${site.line}: cites no ledger row: ${site.text.slice(0, 100)}`];
        const unknown = site.cited.filter(id => !known.has(id));
        return unknown.length ? [`${file}:${site.line}: cites ${unknown.join(', ')}, which is not a ledger row`] : [];
    });
}
