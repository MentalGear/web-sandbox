/**
 * The registry of stable IDs (CONTRIBUTING.md, "Code and docs: the current state"). A comment or a doc cites a finding,
 * a backlog item, an ADR or a model finding by one of these IDs, and the ID resolves to a file and an anchor in it:
 * `R5:M-2` is docs/security/REVIEW-ROUND-5-2026-10-19.md#r5-m-2. The anchor of an ID is idAnchor(id), an HTML anchor
 * (`<a id="r5-m-2"></a>`) on the row or header that defines it. test/unit/doc-links.test.ts resolves every ID cited in
 * src/, test/ and docs/ against this registry and the anchors, so an ID that names nothing fails the unit run.
 * When a document moves (to the archive), its entry here changes, and no citation does.
 */

/** A source of finding IDs: every ID in it is cited as `<prefix>:<id as the report writes it>`. */
export interface PrefixedSource {
    readonly prefix: string;
    readonly file: string;
    readonly title: string;
    readonly example: string;
}

/** The reports whose findings are cited with a prefix, because their own IDs repeat across reports (`M-2`). */
export const PREFIXED_SOURCES = [
    { prefix: 'R1', file: 'docs/security/REVIEW-ROUND-1-2026-10-15.md', title: 'Review round 1', example: 'R1:R3-6' },
    { prefix: 'R2', file: 'docs/security/REVIEW-ROUND-2-2026-10-15.md', title: 'Review round 2', example: 'R2:C-1' },
    { prefix: 'R3', file: 'docs/security/REVIEW-ROUND-3-2026-10-18.md', title: 'Review round 3', example: 'R3:C-1' },
    { prefix: 'R4', file: 'docs/security/REVIEW-ROUND-4-2026-10-18.md', title: 'Review round 4', example: 'R4:M-4' },
    { prefix: 'R5', file: 'docs/security/REVIEW-ROUND-5-2026-10-19.md', title: 'Review round 5', example: 'R5:M-2' },
    { prefix: 'AR', file: 'docs/security/ADVERSARIAL-REVIEW-2026-10.md', title: 'The adversarial review', example: 'AR:B1' },
    { prefix: 'BR', file: 'docs/security/BROAD-REVIEW-2026-10-14.md', title: 'The broad review', example: 'BR:CB1' },
    { prefix: 'FR', file: 'docs/security/FOCUSED-REVIEW-2026-10-14.md', title: 'The focused review', example: 'FR:W1' },
    { prefix: 'VR', file: 'docs/security/VERIFICATION-2026-10-14.md', title: 'The independent verification', example: 'VR:V1' },
    { prefix: 'BL', file: 'docs/BACKLOG.md', title: "The backlog's B, C, D and H items", example: 'BL:D1' },
] as const satisfies readonly PrefixedSource[];

/** The backlog's S and T items, cited bare (`S76`, `T6`): no report uses those letters. */
export const BACKLOG_FILE = 'docs/BACKLOG.md';

/** The ADRs, cited as `ADR-005`, or `ADR-005#<heading anchor>` for one section. */
export const ADRS = {
    'ADR-001': 'docs/ADR-001-continue-or-adopt.md',
    'ADR-002': 'docs/ADR-002-host-guest-broker.md',
    'ADR-003': 'docs/ADR-003-lifecycle-and-liveness.md',
    'ADR-004': 'docs/ADR-004-files-as-blob-urls.md',
    'ADR-005': 'docs/ADR-005-strict-mode.md',
    'ADR-006': 'docs/ADR-006-fetch-bridge.md',
    'ADR-007': 'docs/ADR-007-typed-origins.md',
} as const satisfies Record<`ADR-${number}`, string>;

/** The lifecycle model's findings (research 17), cited bare: `LM-2`. */
export const MODEL_FINDINGS_FILE = 'docs/research/17_formal_methods/lifecycle-model.md';

export type IdPrefix = (typeof PREFIXED_SOURCES)[number]['prefix'];

const PREFIXES = PREFIXED_SOURCES.map(source => source.prefix).join('|');

/**
 * Every ID in the registry's formats, wherever it is cited: a prefixed finding, a backlog S or T item, an ADR (with its
 * optional `#anchor`) or a model finding. Global: use with matchAll.
 */
export const ID_CITATION = new RegExp(
    `\\b(?:(?:${PREFIXES}):[A-Z][A-Za-z0-9]*(?:-\\d+)?|[ST]\\d{1,3}|ADR-\\d{3}(?:#[a-z0-9-]+)?|LM-\\d+)\\b`, 'g');

/**
 * A finding ID cited bare, with no prefix: `M-2`, and round 1's `R3-6`. Each names a row in up to four reports, so it
 * resolves to none; step 5 of S76 rewrites them, and test/unit/history-ratchet.test.ts keeps their count from rising.
 * Global: use with matchAll.
 */
export const BARE_FINDING_ID = /(?<![\w:#/.-])(?:[A-Z]|R\d)-\d+\b(?!-)/g;

/** The fragment that an ID's anchor has: `R5:M-2` → `r5-m-2`, `S76` → `s76`, `LM-2` → `lm-2`. */
export function idAnchor(id: string): string {
    return id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Where an ID resolves: the file, and the anchor in it (none for a whole ADR). Undefined for a format not listed here. */
export function resolveId(id: string): { file: string; anchor?: string } | undefined {
    const colon = id.indexOf(':');
    if (colon > 0) {
        const source = PREFIXED_SOURCES.find(entry => entry.prefix === id.slice(0, colon));
        return source && { file: source.file, anchor: idAnchor(id) };
    }
    if (/^[ST]\d{1,3}$/.test(id)) return { file: BACKLOG_FILE, anchor: idAnchor(id) };
    if (/^LM-\d+$/.test(id)) return { file: MODEL_FINDINGS_FILE, anchor: idAnchor(id) };
    const adr = /^(ADR-\d{3})(?:#([a-z0-9-]+))?$/.exec(id);
    if (adr) {
        const file = (ADRS as Record<string, string>)[adr[1]!];
        return file === undefined ? undefined : adr[2] === undefined ? { file } : { file, anchor: adr[2] };
    }
    return undefined;
}
