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
        launchOptions: {
            args: ['--host-resolver-rules=MAP virtual-files.localhost 127.0.0.1'],
        },
    },
    webServer: {
        command: "bun x vite",
        url: "http://localhost:4444/test/e2e/harness.html",
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe',
        stderr: 'pipe',
    },
})
