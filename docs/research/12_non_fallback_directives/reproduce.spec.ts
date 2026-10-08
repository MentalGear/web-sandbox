import { test, expect, ORIGIN } from '../../../test/e2e/fixture';
import { generateCSP } from '@src/lib/csp/csp-generator';

/**
 * Research 12: directives dropped by the empty-array rule do not all fall back to default-src.
 * Runs on the shared e2e harness (test/e2e/fixture.ts).
 */

const EXFIL = `${ORIGIN}/playground/test-assets/local-image.svg`;

test('12.1 the default policy restricts base-uri and form-action, which have no fallback', () => {
    const policy = generateCSP({
        'upgrade-insecure-requests': true,
        'default-src': ["'none'"],
        'script-src': ["'self'", "'unsafe-inline'"],
        'connect-src': [], 'base-uri': [], 'img-src': [], 'style-src': ["'unsafe-inline'"],
        'font-src': [], 'media-src': [], 'manifest-src': [], 'prefetch-src': [],
        'form-action': [], 'object-src': [], 'frame-src': [], 'frame-ancestors': [],
        'worker-src': ['blob:', 'data:'],
    } as any);

    // frame-src and object-src are covered by the default-src fallback - fine that they are absent.
    // base-uri and form-action are NOT, so their absence means "unrestricted".
    // Fixed (backlog S9): an empty non-fallback directive is emitted as 'none'.
    expect(policy, 'base-uri has no default-src fallback').toContain("base-uri 'none'");
    expect(policy, 'form-action has no default-src fallback').toContain("form-action 'none'");
});

test('12.2 form-action: a GET form cannot exfiltrate to a non-allowlisted target', async ({ sandbox, page }) => {
    const reached: string[] = [];
    page.on('request', r => { if (r.url().startsWith(EXFIL)) reached.push(r.url()); });

    // allow-forms is a sanctioned value in SAFE_CAPABILITIES
    await sandbox.mount({ capabilities: ['allow-scripts', 'allow-forms'] });
    await sandbox.load(`<html><head><title>t</title></head><body>
        <form id="f" action="${EXFIL}" method="GET">
          <input name="stolen" value="session-secret">
        </form>
        <script>document.getElementById('f').submit();</script>
    </body></html>`);

    await page.waitForTimeout(3000);

    expect(reached, 'form submission escaped the network policy').toHaveLength(0);
});
