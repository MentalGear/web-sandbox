import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which e2e server a run tests (backlog T8): always the one serving this checkout, by construction. Imported by
 * playwright.config.ts (the server it starts or reuses) and by fixture.ts (the origin every spec loads).
 *
 * - E2E_ROOT: the absolute, physical path of the checkout this file is in.
 * - E2E_PORT: WEB_SANDBOX_E2E_PORT when set; else 4444 in CI (one checkout per machine there); else a port derived from
 *   E2E_ROOT, so that two checkouts or worktrees on one machine do not share one port, and each can run its suite while
 *   the other does.
 * - E2E_PROBE: what Playwright polls before it reuses a server or once it started one. The server answers 200 only when
 *   the root asked for is the root it serves (vite.config.ts, /__e2e-root), and 409 to any other, which Playwright counts
 *   as no server: it then starts this checkout's own, which fails on the taken port, and the run stops with that error.
 *   So a run never tests another checkout's code, even when two derived ports collide or a server is left running.
 *   The path is its own on purpose: a server that answers only `/__e2e`, which answers 200 to any query, answers this
 *   path 404, so it is never reused either.
 */
export const E2E_ROOT = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));

export const CI_PORT = 4444;

// FNV-1a of the path, into 20000–29999: below Linux's ephemeral range (32768+, where the specs' own listeners bind
// port 0) and above every port the engines refuse to load (Chromium's and Firefox's lists end at 10080).
export function portFor(root: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < root.length; i++) hash = Math.imul(hash ^ root.charCodeAt(i), 0x01000193) >>> 0;
    return 20000 + (hash % 10000);
}

export const E2E_PORT = Number(process.env.WEB_SANDBOX_E2E_PORT) || (process.env.CI ? CI_PORT : portFor(E2E_ROOT));
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
export const E2E_PROBE = `${E2E_ORIGIN}/__e2e-root?root=${encodeURIComponent(E2E_ROOT)}`;
