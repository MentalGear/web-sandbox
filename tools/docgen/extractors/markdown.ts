/** Markdown the extractors write the same way: table cells and tables. */
import type { Item } from '../engine';

/** A table cell: pipes escaped, line breaks folded to spaces. */
export const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

/** A table row. */
export const row = (cells: readonly string[]): string => `| ${cells.map(cell).join(' | ')} |`;

/** A table: its header, its alignment line and its rows (each a row() of cells). */
export const table = (header: readonly string[], rows: readonly string[]): string =>
    [row(header), `| ${header.map(() => ':---').join(' | ')} |`, ...rows].join('\n');

/** `text` as a code span, whatever it holds (a span with a backtick in it takes a longer fence). */
export const code = (text: string): string => (text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``);

/** A list as code spans, comma separated. */
export const codeList = (values: readonly string[]): string => values.map(code).join(', ');

/** What an extractor module gives the plugin: region renderers, and the items markers may name. */
export interface Extractor {
    readonly regions: Readonly<Record<string, () => string>>;
    items(): readonly Item[];
}
