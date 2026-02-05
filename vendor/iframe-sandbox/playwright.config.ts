import { defineConfig } from "@playwright/test"

export default defineConfig({
    testDir: "./test/e2e",
    timeout: 30000,
    use: {
        baseURL: "http://localhost:3333",
        headless: true,
    },
    webServer: {
        command: "bun server.ts",
        url: "http://localhost:3333",
        reuseExistingServer: true,
    },
})
