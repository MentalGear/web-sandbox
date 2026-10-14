import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
    // e2e specs and the research reproductions both run against test/e2e/harness.html
    testDir: ".",
    testMatch: ["test/e2e/**/*.spec.ts", "docs/research/**/*.spec.ts"],
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
        baseURL: "http://localhost:4444",
        headless: true,
    },
    webServer: {
        // build the package first: test/e2e/package.spec.ts mounts the sandbox from dist/
        command: "bun run build:lib && bun x vite",
        // no HMR socket (vite.config.ts): a file written during a run never reloads a page under test.
        // /__e2e answers only on such a server, so a running `bun run dev` is not reused (port 4444 is
        // then taken, and the run stops with that error instead of failing at random).
        env: { WEB_SANDBOX_E2E: "1" },
        url: "http://localhost:4444/__e2e",
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe',
        stderr: 'pipe',
    },
})
