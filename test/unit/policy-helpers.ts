/**
 * Helpers for the policy tests of the adversarial review 2026-10 (A1): a browser's reading of a policy string,
 * and a seeded source of injection-shaped strings. Not a test file itself.
 */
/** A policy as a browser reads it (CSP Level 3, 2.2.1): ';'-separated, names lower-cased, the first occurrence wins. */
export function parseLikeABrowser(policy: string): { names: string[]; directives: Map<string, string[]> } {
    const names: string[] = [];
    const directives = new Map<string, string[]>();
    for (const part of policy.split(';')) {
        const [name, ...tokens] = part.trim().split(/[\t\n\f\r ]+/);
        if (!name) continue;
        const lower = name.toLowerCase();
        names.push(lower);
        if (!directives.has(lower)) directives.set(lower, tokens.filter(token => token !== ''));
    }
    return { names, directives };
}

// A seeded generator, so a failure names a reproducible case.
export function prng(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

const FRAGMENTS = [';', ',', ' ', '\t', '\n', '\f', '\r', '\u000b', '\u00a0', "'", '"', '<', '&', '*', ':', '/',
    "'none'", "'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://a.example', 'blob:', 'script-src', 'script-src-attr',
    'script-src-elem', 'frame-src', 'base-uri', 'form-action', 'worker-src', 'default-src', 'sandbox', 'report-uri'];

export function randomInjection(random: () => number): string {
    let out = '';
    const parts = 1 + Math.floor(random() * 7);
    for (let i = 0; i < parts; i++) out += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
    return out;
}

