/**
 * What the history ratchet counts (test/unit/history-ratchet.test.ts): per file, the comment lines that match a strict
 * history pattern, and the finding IDs its comments cite with no prefix (docs/ids.ts, BARE_FINDING_ID).
 */
import { BARE_FINDING_ID } from '../../docs/ids';
import { comments } from '../../scripts/js-tokens';

/** The strict history patterns, each tried on one comment line. */
export const HISTORY_PATTERNS: Readonly<Record<string, RegExp>> = {
    sha: /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/,
    date: /\b20\d\d-\d\d(-\d\d)?\b/,
    round: /\b(review )?round[ -]?\d\b|\bat round\b/i,
    finding: /\bfinding [A-Z]+\d*-?\d+\b/i,
    namedReview: /\b(focused|broad|adversarial) review\b|\breview [A-Z]\d\b|\bverification 20/i,
    prPhase: /\bPR [A-D]\b|\b(until|since) (PR|S\d)/,
    measuredAt: /\bmeasured (at|on)\b/i,
    gone: /\bused to\b|\bno longer\b|\bpreviously\b|\bany more\b|\bformerly\b/i,
};

/** A file's comment text, line by line (the comment markers and the leading `*` removed), by line number. */
export function commentLines(text: string): Map<number, string> {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    const lineOf = (offset: number) => {
        let low = 0, high = lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (lineStarts[mid]! <= offset) low = mid; else high = mid - 1;
        }
        return low + 1;
    };
    const lines = new Map<number, string>();
    for (const comment of comments(text)) {
        let line = lineOf(comment.start);
        for (const part of comment.text.split('\n')) {
            const body = part.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/)\s?/, '').replace(/\*\/\s*$/, '').trim();
            if (body) lines.set(line, `${lines.get(line) ?? ''} ${body}`);
            line++;
        }
    }
    return lines;
}

export interface Counts { history: Record<string, number>; bareIds: Record<string, number> }

/** The counts of the given files; a file with none is left out. */
export function count(files: readonly string[], read: (file: string) => string): Counts {
    const counts: Counts = { history: {}, bareIds: {} };
    for (const file of files) {
        let history = 0, bareIds = 0;
        for (const line of commentLines(read(file)).values()) {
            if (Object.values(HISTORY_PATTERNS).some(pattern => pattern.test(line))) history++;
            bareIds += [...line.matchAll(BARE_FINDING_ID)].length;
        }
        if (history) counts.history[file] = history;
        if (bareIds) counts.bareIds[file] = bareIds;
    }
    return counts;
}

