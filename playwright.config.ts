import { defineConfig, devices } from "@playwright/test"
import { join } from "node:path"
import { E2E_ORIGIN, E2E_PORT, E2E_PROBE, E2E_ROOT } from "./test/e2e/server"

// A run tests its own checkout, by construction (backlog T8; CONTRIBUTING.md, "End-to-end tests"):
// - the server: on E2E_PORT (4444 in CI; locally a port derived from this checkout's path, or WEB_SANDBOX_E2E_PORT), and
//   reused only when its /__e2e-root answers that it serves E2E_ROOT, this checkout. Another checkout's server is never
//   reused: Playwright starts this checkout's own, and if the port is taken the run stops with that error.
// - the specs: only this checkout's. Patterns are matched against absolute paths with `**/` put in front, so a relative
//   ignore such as '.claude/**' would also match every file of a checkout that itself lives under .claude/worktrees/.
//   The ignore is anchored at this checkout's root instead: worktrees and scratch copies nested in it are skipped, and
//   a checkout under another's .claude/ still finds its own specs.
const escapeRegExp = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
const NESTED = new RegExp(`^${escapeRegExp(join(E2E_ROOT, ".claude"))}[\\\\/]`)

export default defineConfig({
    // e2e specs and the research reproductions both run against test/e2e/harness.html
    testDir: ".",
    testMatch: ["test/e2e/**/*.spec.ts", "docs/research/**/*.spec.ts"],
    testIgnore: ["**/node_modules/**", NESTED],
    timeout: 30000,
    forbidOnly: !!process.env.CI,
    reporter: process.env.CI ? [["list"], ["github"]] : "list",
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'] },
        },
        // WebKit often fails in CI/Container environments without specific deps,
        // but adding it as requested.
        {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
        },
    ],
    use: {
        baseURL: E2E_ORIGIN,
        headless: true,
    },
    webServer: {
        // build the package first: test/e2e/package.spec.ts mounts the sandbox from dist/
        command: "bun run build:lib && bun x vite",
        // no HMR socket (vite.config.ts): a file written during a run never reloads a page under test.
        // /__e2e-root answers only on such a server, and 200 only for the root it serves (above), so neither a running
        // `bun run dev` nor another checkout's e2e server is reused.
        env: { WEB_SANDBOX_E2E: "1", WEB_SANDBOX_E2E_PORT: String(E2E_PORT) },
        url: E2E_PROBE,
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe',
        stderr: 'pipe',
    },
})
