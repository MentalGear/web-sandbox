import { defineConfig } from "@playwright/test"

export default defineConfig({
    testDir: "test/lofi",
    timeout: 30000,
    use: {
        baseURL: "http://localhost:4444",
        headless: true,
        launchOptions: {
            // Map virtual-files.localhost to 127.0.0.1
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
