import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Research 15 (strict-mode probes) runs on its own: its own static server (port 4466, or STRICT_PROBE_PORT) and no
 * dependency on the e2e harness or the 4444 vite server. Under the repository's root config these tests are
 * skipped; CI runs them with this config (`bun run test:probes`, .github/workflows/ci.yml), since ADR-005 rests on
 * what they measure. Run from the repository root:
 *
 *   bun run test:probes                      # all three engines; add --project=chromium for one
 *
 * Chromium: CHROMIUM_EXECUTABLE, else /opt/pw-browsers/chromium when present, else Playwright's own.
 */
const PORT = Number(process.env.STRICT_PROBE_PORT || 4466);
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
        baseURL: `http://localhost:${PORT}`,
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
        command: 'bun server.mjs', // STRICT_PROBE_PORT reaches it through the environment
        url: `http://localhost:${PORT}/host.html`,
        reuseExistingServer: false,
        stdout: 'pipe',
        stderr: 'pipe',
    },
});
