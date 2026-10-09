import { test as base, expect, type Page } from '@playwright/test';
import type { SandboxConfig } from '@src/host';

export const ORIGIN = 'http://localhost:4444';
export const HARNESS = `${ORIGIN}/test/e2e/harness.html`;

// What the specs need to run anything at all: scripts in the frame and execute().
export const BASELINE_CONFIG: Partial<SandboxConfig> = {
    capabilities: ['allow-scripts'],
    scriptUnsafe: true,
};

export type MountResult = 'ready' | 'terminated';

/**
 * Drives the <lofi-sandbox> element on the harness page.
 * Specs talk to this instead of the page, so moving the playground or renaming internals
 * breaks one file instead of every spec.
 */
export class SandboxDriver {
    constructor(readonly page: Page) {}

    async open() {
        await this.page.goto(HARNESS);
        await this.page.waitForFunction(() => (window as any).harnessReady === true);
    }

    /** Applies BASELINE_CONFIG merged with `config`, and waits for the sandbox to become ready. */
    async mount(config: Partial<SandboxConfig> = {}): Promise<MountResult> {
        return this.page.evaluate((merged) => whenSettled(s => s.setConfig(merged)), { ...BASELINE_CONFIG, ...config } as any);
    }

    /** Loads guest markup into the current sandbox and waits for it to become ready. */
    async load(html: string): Promise<MountResult> {
        return this.page.evaluate((markup) => whenSettled(s => s.load(markup)), html);
    }

    async run(code: string) {
        await this.page.evaluate((source) => (document.querySelector('lofi-sandbox') as any).execute(source), code);
    }

    async logs(): Promise<string[]> {
        return this.page.evaluate(() => [...(window as any).sandboxLogs]);
    }

    async clearLogs() {
        await this.page.evaluate(() => { (window as any).sandboxLogs.length = 0; });
    }

    /** Runs `code` and returns every log line once it logs TEST_DONE (the presets' completion signal). */
    async runUntilDone(code: string, timeout = 10000): Promise<string[]> {
        await this.run(code);
        await this.waitForLog('TEST_DONE', timeout);
        return this.logs();
    }

    /** Resolves with the first log line matching `pattern`; throws on timeout. */
    async waitForLog(pattern: string | RegExp, timeout = 5000): Promise<string> {
        const source = typeof pattern === 'string' ? pattern : pattern.source;
        const isRegExp = typeof pattern !== 'string';
        const handle = await this.page.waitForFunction(({ source, isRegExp }) => {
            const logs: string[] = (window as any).sandboxLogs;
            return logs.find(line => isRegExp ? new RegExp(source).test(line) : line.includes(source));
        }, { source, isRegExp }, { timeout });
        return handle.jsonValue() as Promise<string>;
    }
}

// Injected into the page: resolves once the sandbox reports 'ready' or 'terminated'.
declare global { function whenSettled(action: (sandbox: any) => void): Promise<MountResult>; }

export const test = base.extend<{ sandbox: SandboxDriver }>({
    sandbox: async ({ page }, use) => {
        await page.addInitScript(() => {
            (window as any).whenSettled = (action: (sandbox: any) => void) => new Promise(resolve => {
                const sandbox = document.querySelector('lofi-sandbox') as any;
                const settle = (event: Event) => {
                    sandbox.removeEventListener('ready', settle);
                    sandbox.removeEventListener('terminated', settle);
                    resolve(event.type);
                };
                sandbox.addEventListener('ready', settle);
                sandbox.addEventListener('terminated', settle);
                action(sandbox);
            });
        });
        const driver = new SandboxDriver(page);
        await driver.open();
        await use(driver);
    },
});

export { expect };
