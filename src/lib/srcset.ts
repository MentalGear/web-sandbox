/**
 * The URLs of a `srcset` attribute (ADR-004, PR4). Host-only.
 *
 * Follows the HTML standard's "parse a srcset attribute"
 * (https://html.spec.whatwg.org/multipage/images.html#parse-a-srcset-attribute) as far as it decides
 * where each candidate's URL is: leading whitespace and commas are skipped; a URL is a run of
 * non-whitespace, so a comma inside it belongs to it (`a,b.png 1x` is one URL, as is a `data:` URL);
 * trailing commas end the candidate and are not part of the URL; otherwise descriptors follow, up to a
 * comma outside parentheses. Descriptors are not validated: a candidate the browser drops for a bad
 * descriptor loads nothing, whichever URL it holds.
 */

export interface SrcsetCandidate {
    start: number; // [start, end): the URL within the attribute value
    end: number;
    url: string;
}

const isWhitespace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';

/** Every candidate URL of `value`, in order. Never throws. */
export function srcsetCandidates(value: string): SrcsetCandidate[] {
    const candidates: SrcsetCandidate[] = [];
    const n = value.length;
    let i = 0;
    for (;;) {
        // splitting loop: whitespace and commas between candidates
        while (i < n && (isWhitespace(value[i]) || value[i] === ',')) i++;
        if (i >= n) return candidates;

        const start = i;
        while (i < n && !isWhitespace(value[i])) i++;
        let end = i;
        if (value[end - 1] === ',') {
            // trailing commas end the candidate, with no descriptors
            while (end > start && value[end - 1] === ',') end--;
            candidates.push({ start, end, url: value.slice(start, end) });
            continue;
        }
        candidates.push({ start, end, url: value.slice(start, end) });

        // descriptor tokenizer: up to a comma outside parentheses, or the end
        let state: 'in descriptor' | 'in parens' | 'after descriptor' = 'in descriptor';
        while (i < n && isWhitespace(value[i])) i++;
        for (; i < n; i++) {
            const c = value[i];
            if (state === 'in descriptor') {
                if (isWhitespace(c)) state = 'after descriptor';
                else if (c === ',') { i++; break; }
                else if (c === '(') state = 'in parens';
            } else if (state === 'in parens') {
                if (c === ')') state = 'in descriptor';
            } else if (!isWhitespace(c)) {
                state = 'in descriptor';
                i--; // reconsume in the descriptor state
            }
        }
    }
}
