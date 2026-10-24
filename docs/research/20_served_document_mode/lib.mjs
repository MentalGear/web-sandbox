// Shared helpers for the research 20 probes: engine selection, load guard, small statistics.
import { readFileSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';

export const ENGINES = { chromium, firefox, webkit };

/** Engines named on the command line (`chromium firefox webkit`), or all three. */
export function engineArgs(argv = process.argv.slice(2)) {
    const named = argv.filter((a) => a in ENGINES);
    return named.length ? named : ['chromium', 'firefox', 'webkit'];
}

/** The 1-minute load average. The timing probes wait while it is above 6 (the machine is shared). */
export function load1() {
    try { return Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]); } catch { return 0; }
}

export async function waitForQuiet(limit = 6, label = '') {
    for (let i = 0; i < 120 && load1() > limit; i++) {
        console.error(`load ${load1()} > ${limit}, waiting ${label}`);
        await new Promise((r) => setTimeout(r, 5000));
    }
}

export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const range = (xs) => `${Math.min(...xs)}-${Math.max(...xs)}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One JSON line per result, prefixed with a tag, so the README's tables can be rebuilt with grep. */
export function emit(tag, obj) { console.log(`${tag} ${JSON.stringify(obj)}`); }

export const html = (head, body = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
