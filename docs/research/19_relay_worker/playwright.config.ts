import { defineConfig, devices } from '@playwright/test';

/**
 * Research 19 (relay-worker probes) runs on its own, like research 15: its own Bun server (server.mjs: 5050 for the host
 * page, 5051 for the network canary; RELAY_PROBE_PORT, RELAY_PROBE_CANARY_PORT) and no dependency on the e2e harness or
 * the 4444 vite server. Under the repository's root config these tests are skipped. Run from the repository root:
 *
 *   bunx playwright test -c docs/research/19_relay_worker                    # all four projects
 *   bunx playwright test -c docs/research/19_relay_worker --project=firefox  # one
 *
 * Projects: 'chromium' is Playwright's headless shell (the view on the host page's thread, research 16);
 * 'chromium-desktop' is the full Chromium build in new headless mode (channel 'chromium': the view in its own process).
 */
const PORT = Number(process.env.RELAY_PROBE_PORT || 5050);

export default defineConfig({
    testDir: '.',
    testMatch: ['probe.spec.ts'],
    timeout: 120000,
    fullyParallel: false,
    workers: 1, // host-page busy time and memory are measured: no concurrent browsers competing for the CPU
    reporter: 'list',
    metadata: { relayProbes: true },
    use: {
        baseURL: `http://localhost:${PORT}`,
        headless: true,
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
    webServer: {
        command: 'bun server.mjs',
        url: `http://localhost:${PORT}/host.html`,
        reuseExistingServer: false,
        stdout: 'pipe',
        stderr: 'pipe',
    },
});
