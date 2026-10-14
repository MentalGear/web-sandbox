import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Research 15 (strict-mode probes) runs on its own: its own static server on port 4466 and no
 * dependency on the e2e harness or the 4444 vite server. Run from the repository root:
 *
 *   PLAYWRIGHT_BROWSERS_PATH=<dir with firefox/webkit> bunx playwright test -c docs/research/15_strict_mode
 *
 * Chromium: CHROMIUM_EXECUTABLE, else /opt/pw-browsers/chromium when present, else Playwright's own.
 */
const chromiumExecutable = process.env.CHROMIUM_EXECUTABLE
    ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
    testDir: '.',
    testMatch: ['probe.spec.ts'],
    timeout: 60000,
    fullyParallel: false,
    workers: 1, // P7 measures host responsiveness: no concurrent browsers competing for the CPU
    reporter: 'list',
    metadata: { strictProbes: true },
    use: {
        baseURL: 'http://localhost:4466',
        headless: true,
        ignoreHTTPSErrors: true, // the loopback listener's certificate is made per run
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {} },
        },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
    webServer: {
        command: 'node server.mjs',
        url: 'http://localhost:4466/host.html',
        reuseExistingServer: false,
        stdout: 'pipe',
        stderr: 'pipe',
    },
});
