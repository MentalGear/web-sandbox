import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
    testDir: "test/lofi",
    timeout: 30000,
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
        command: "bun vendor/lofi-web-sandbox/index.ts",
        url: "http://localhost:4444",
        reuseExistingServer: !true,
        stdout: 'pipe',
        stderr: 'pipe',
    },
})
