import { test, expect, HARNESS, ORIGIN } from '../../../test/e2e/fixture';

/**
 * Research 11: CSP delivery via <meta> — limits and failure modes.
 * Runs on the shared e2e harness (test/e2e/fixture.ts).
 */

const PLAYGROUND = HARNESS;
const ASSET = `${ORIGIN}/playground/test-assets/local-image.svg`;

test.describe('Research 11: meta-CSP delivery', () => {

    // 11.1 — frame-ancestors / report-uri / sandbox are discarded by the browser.
    test('11.1 the browser ignores three directives delivered via <meta>', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'asserts on the console warning text Chromium prints');
        const warnings: string[] = [];
        page.on('console', m => {
            if (/ignored when delivered via a <meta> element/i.test(m.text())) warnings.push(m.text());
        });

        await page.goto(PLAYGROUND);
        await page.evaluate(() => {
            const f = document.createElement('iframe');
            f.setAttribute('sandbox', 'allow-scripts');
            f.srcdoc = `<!DOCTYPE html><html><head>
                <meta http-equiv="Content-Security-Policy"
                      content="default-src 'none'; frame-ancestors 'none'; report-uri /r; sandbox allow-scripts;">
            </head><body></body></html>`;
            document.body.appendChild(f);
        });
        await page.waitForTimeout(1000);

        // If this ever fails, the browser has started honouring them - revisit 11.1.
        expect(warnings.join(' ')).toContain('frame-ancestors');
    });

    // 11.2 — a policy parsed into <body> is not applied at all.
    test('11.2 a meta CSP outside <head> is dropped entirely', async ({ page }) => {
        await page.goto(PLAYGROUND);

        const escaped = await page.evaluate(async ({ asset }) => {
            const build = (doc: string) => new Promise<boolean>(resolve => {
                const f = document.createElement('iframe');
                f.setAttribute('sandbox', 'allow-scripts');
                const handler = (e: MessageEvent) => {
                    if (!e.data || !('loaded' in e.data)) return;
                    window.removeEventListener('message', handler);
                    resolve(e.data.loaded);
                };
                window.addEventListener('message', handler);
                f.srcdoc = doc;
                document.body.appendChild(f);
                setTimeout(() => resolve(false), 3000);
            });

            const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline';">`;
            const probe = `<script>
                const i = new Image();
                i.onload  = () => parent.postMessage({loaded: true}, '*');
                i.onerror = () => parent.postMessage({loaded: false}, '*');
                i.src = '${asset}';
            </script>`;

            return {
                // an <img> in <head> implicitly closes it, pushing the meta into <body>
                metaPushedToBody: await build(`<!DOCTYPE html><html><head><img src="${asset}">${csp}</head><body>${probe}</body></html>`),
                metaInHead:       await build(`<!DOCTYPE html><html><head>${csp}</head><body>${probe}</body></html>`),
            };
        }, { asset: ASSET });

        expect(escaped.metaInHead).toBe(false);        // policy applied
        expect(escaped.metaPushedToBody).toBe(true);   // policy silently absent
    });

    // 11.3 — the security block used to be regex-spliced into user markup, where a comment could swallow it.
    // Fixed by prepending the block before any user content (backlog S2, src/lib/frame-documents.ts).
    test('11.3 user content cannot delete the injected CSP', async ({ sandbox }) => {
        await sandbox.mount();

        const payloads = [
            `<html><body><!-- <head> --></body></html>`,
            `<!-- <html><head> --><html><head></head><body></body></html>`,
            `<html><head><img src=x><!--</head><body></body></html>`,
            `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p>full document</p></body></html>`,
            `<textarea><head></textarea>`,
            `<plaintext>`,
        ];

        for (const payload of payloads) {
            await sandbox.clearLogs();
            await sandbox.load(payload);
            await sandbox.run(`
                const meta = document.head.firstElementChild;
                console.log('CSP_FIRST_IN_HEAD ' + (meta?.getAttribute('http-equiv') === 'Content-Security-Policy'));
            `);
            expect(await sandbox.waitForLog('CSP_FIRST_IN_HEAD'), `payload: ${payload}`).toBe('CSP_FIRST_IN_HEAD true');
        }
    });
});
