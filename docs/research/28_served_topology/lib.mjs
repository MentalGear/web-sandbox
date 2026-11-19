// Shared helpers for the research 28 probes: engine selection, versions, load average, small statistics, one JSON line
// per result. Copied from research 27's lib.mjs, with the full Chromium build (`chromium-full`) as a fourth engine name.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';

export const ENGINES = { chromium, firefox, webkit };

/** Launch options per engine name: `chromium-full` is the full Chromium build in new headless mode, not the headless shell. */
export function launcher(name) {
    if (name === 'chromium-full') return { type: chromium, options: { channel: 'chromium' } };
    return { type: ENGINES[name], options: {} };
}

/** Engines named on the command line (`chromium firefox webkit`), or all three. */
export function engineArgs(argv = process.argv.slice(2)) {
    const named = argv.filter((a) => a in ENGINES || a === 'chromium-full');
    return named.length ? named : ['chromium', 'firefox', 'webkit'];
}

/** The 1-minute load average (the machine is shared; the timing probe records it with every result). */
export function load1() {
    try { return Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]); } catch { return 0; }
}

export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const range = (xs) => `${Math.min(...xs)}-${Math.max(...xs)}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One JSON line per result, prefixed with a tag, so the README's tables can be rebuilt with grep. */
export function emit(tag, obj) { console.log(`${tag} ${JSON.stringify(obj)}`); }

/** The engine and its version, the date, and the load, as the first line of every run. */
export function emitRun(tag, name, browser) {
    emit(`${tag}.run`, { engine: name, version: browser.version(), date: new Date().toISOString(), load1: load1() });
}

export const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
export const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

/** Console lines that name a policy, from every frame of the page (the engines' warnings about `<meta>` directives). */
export function collectConsole(page) {
    const lines = [];
    page.on('console', (m) => { const t = m.text(); if (/policy|meta|sandbox|frame-ancestors|report/i.test(t)) lines.push(t.slice(0, 220)); });
    return lines;
}
