import { test, expect, Page } from "@playwright/test"
import { PRESETS } from "../../src/lib/presets"

/**
 * Helper: Wait for sandbox to be ready and set network rules
 */
async function setupSandbox(page: Page, rules: object) {
    // Wait for sandbox ready indicator
    await expect(page.locator("#sandbox-status")).toContainText("Ready", {
        timeout: 10000,
    })

    // Set rules in the JSON editor
    const rulesEditor = page.locator("#rulesEditor")
    await rulesEditor.fill(JSON.stringify(rules, null, 2))

    // Wait for debounced rule application
    await page.waitForTimeout(600)
}

/**
 * Helper: Execute code in sandbox and wait for logs
 */
async function executeAndWaitForLog(
    page: Page,
    code: string,
    expectedLogPattern: RegExp,
    timeout = 5000,
) {
    const logsDiv = page.locator("#logs")

    // Clear existing logs
    await page.click('button:has-text("Clear Logs")')

    // Set code
    await page.locator("#code").fill(code)

    // Run
    await page.click('button:has-text("Run Code")')

    // Wait for expected log
    await expect(logsDiv).toContainText(expectedLogPattern, { timeout })
}

// ============================================================================
// Test: JSONPlaceholder (CORS Allowed, Direct Fetch)
// ============================================================================
test.describe("JSONPlaceholder Preset", () => {
    test("direct fetch succeeds without proxy", async ({ page }) => {
        await page.goto("/")

        await setupSandbox(page, PRESETS.jsonplaceholder.rules)

        await executeAndWaitForLog(
            page,
            `fetch("https://jsonplaceholder.typicode.com/todos/1");`,
            /Fetch.*jsonplaceholder/,
        )

        // Should see 200 status
        await expect(page.locator("#logs")).toContainText(/200/)
    })
})

// ============================================================================
// Test: Google (CORS Blocked without Proxy, Works with Proxy)
// ============================================================================
test.describe("Google Preset", () => {
    test("fetch fails without proxy (CORS error)", async ({ page }) => {
        await page.goto("/")

        await setupSandbox(page, {
            ...PRESETS.google.rules,
            proxyUrl: undefined,
        })

        await executeAndWaitForLog(
            page,
            `fetch("https://www.google.com");`,
            /Fetch.*google/,
        )

        // Should see error (502 or CORS failure)
        await expect(page.locator("#logs")).toContainText(
            /502|CORS|error|proxyUrl/i,
        )
    })

    // SKIPPED: Proxy functionality is currently disabled/deactivated.
    test.skip("fetch succeeds with proxy enabled", async ({ page }) => {
        await page.goto("/")

        await setupSandbox(page, PRESETS.google.rules)

        await executeAndWaitForLog(
            page,
            `fetch("https://www.google.com");`,
            /Proxy.*google/,
        )

        // Should see 200 status via proxy
        await expect(page.locator("#logs")).toContainText(/200/)
    })
})

// ============================================================================
// Test: Block All
// ============================================================================
test.describe("Block All Preset", () => {
    test("all external requests blocked by CSP", async ({ page }) => {
        await page.goto("/")

        await setupSandbox(page, PRESETS.blocked.rules)

        await executeAndWaitForLog(
            page,
            `fetch("https://example.com").catch(e => console.error(e));`,
            // Expect the browser to block it.
            // In CSP mode, we get a Security Violation log AND a fetch TypeError
            /Security Violation.*connect-src/,
        )
    })
})

// ============================================================================
// Test: Virtual Files
// ============================================================================
test.describe("Virtual Files", () => {
    test("virtual file is served from memory", async ({ page }) => {
        await page.goto("/")

        const virtualContent = "Hello from virtual file!"

        await setupSandbox(page, PRESETS.virtualfiles.rules)

        await executeAndWaitForLog(
            page,
            PRESETS.virtualfiles.code,
            /Config:.*1.0/,
        )
        await expect(page.locator("#logs")).toContainText(/Data:.*Hello World/)
    })
})

// ============================================================================
// Test: CSP Flags (Strict Mode)
// ============================================================================
test.describe("CSP Flags", () => {
    test("eval() is blocked by default", async ({ page }) => {
        await page.goto("/")

        // Default rules (no scriptUnsafe)
        await setupSandbox(page, { allow: [] })

        await executeAndWaitForLog(
            page,
            `console.log("Should not run");`,
            // Expect the specific error message the user confirmed
            /Execution Error:.*EvalError.*unsafe-eval/,
        )
    })

    test("eval() is allowed with scriptUnsafe: true", async ({ page }) => {
        await page.goto("/")

        // Enable scriptUnsafe
        await setupSandbox(page, { allow: [], scriptUnsafe: true })

        await executeAndWaitForLog(
            page,
            `const result = eval("1+1"); console.log("Eval result: " + result);`,
            /Eval result: 2/,
        )
    })
})

// ============================================================================
// Test: Code Execution
// ============================================================================
// SKIPPED: Works manually, fails in CI due to origin aliasing issues.
// See docs/sandbox_architecture_decisions.md
test.describe.skip("Code Execution", () => {
    test("execute() runs code and logs appear in host", async ({ page }) => {
        await page.goto("/")

        await expect(page.locator("#sandbox-status")).toContainText("Ready", {
            timeout: 10000,
        })

        await page.click('button:has-text("Clear Logs")')

        // Set simple code that logs a unique message
        const uniqueMessage = `test-${Date.now()}`
        await page.locator("#code").fill(`console.log("${uniqueMessage}");`)

        await page.click('button:has-text("Run Code")')

        // Verify the log appears in host
        await expect(page.locator("#logs")).toContainText(uniqueMessage, {
            timeout: 5000,
        })
    })
})

// ============================================================================
// Test: Log Message Schema
// ============================================================================
// SKIPPED: Depends on messaging relay (fails in CI).
test.describe.skip("Log Message Schema", () => {
    test("logs show source and area tags", async ({ page }) => {
        await page.goto("/")

        await setupSandbox(page, PRESETS.jsonplaceholder.rules)

        await executeAndWaitForLog(
            page,
            `fetch("https://jsonplaceholder.typicode.com/todos/1");`,
            /\[outer:network\]/,
        )
    })

    test("user code logs show inner source", async ({ page }) => {
        await page.goto("/")

        await expect(page.locator("#sandbox-status")).toContainText("Ready", {
            timeout: 10000,
        })

        await page.click('button:has-text("Clear Logs")')
        await page.locator("#code").fill(`console.log("user log test");`)
        await page.click('button:has-text("Run Code")')

        // Should show inner source with user-code area
        await expect(page.locator("#logs")).toContainText(
            /\[inner.*\].*user log test/,
            {
                timeout: 5000,
            },
        )
    })
})

// ============================================================================
// Test: Security Isolation
// ============================================================================
// SKIPPED: Works manually, fails in CI due to origin aliasing issues.
// See docs/sandbox_architecture_decisions.md
test.describe.skip("Security Isolation", () => {
    test("alert() is blocked", async ({ page }) => {
        await page.goto("/")

        await expect(page.locator("#sandbox-status")).toContainText("Ready", {
            timeout: 10000,
        })

        // Set up dialog handler - should NOT be called
        let dialogAppeared = false
        page.on("dialog", async (dialog) => {
            dialogAppeared = true
            await dialog.dismiss()
        })

        await page.click('button:has-text("Clear Logs")')
        await page.locator("#code").fill(`
            alert("Test alert");
            console.log("PASS: alert called without error");
        `)
        await page.click('button:has-text("Run Code")')

        // Wait for log
        await expect(page.locator("#logs")).toContainText(
            /PASS.*alert called/,
            {
                timeout: 5000,
            },
        )

        // Verify no dialog appeared
        expect(dialogAppeared).toBe(false)
    })

    test("window.top is inaccessible", async ({ page }) => {
        await page.goto("/")

        await expect(page.locator("#sandbox-status")).toContainText("Ready", {
            timeout: 10000,
        })

        await page.click('button:has-text("Clear Logs")')
        await page.locator("#code").fill(`
            try {
                const top = window.top.location.href;
                console.log("FAIL: window.top accessible");
            } catch (e) {
                console.log("PASS: window.top blocked");
            }
        `)
        await page.click('button:has-text("Run Code")')

        await expect(page.locator("#logs")).toContainText(
            /PASS.*window\.top blocked/,
            {
                timeout: 5000,
            },
        )
    })

    test("cookies are isolated from host", async ({ page }) => {
        await page.goto("/")

        // Set a cookie on the host
        await page.context().addCookies([
            {
                name: "host_cookie",
                value: "host_value",
                domain: "localhost",
                path: "/",
            },
        ])

        await expect(page.locator("#sandbox-status")).toContainText("Ready", {
            timeout: 10000,
        })

        await page.click('button:has-text("Clear Logs")')
        await page.locator("#code").fill(`
            // Try to set sandbox cookie
            document.cookie = "sandbox_test=123; SameSite=Lax";

            // Host cookie isolation check
            const hasHost = document.cookie.includes("host_cookie");
            console.log(hasHost ? "FAIL: Host cookie visible" : "PASS: Host cookie isolated");

            // Log local state
            console.log("Sandbox cookie set:", document.cookie.includes("sandbox_test") ? "YES" : "NO");
            console.log("Raw cookie jar:", document.cookie || "(empty)");
        `)
        await page.click('button:has-text("Run Code")')

        await expect(page.locator("#logs")).toContainText(
            /PASS: Host cookie isolated/,
            {
                timeout: 5000,
            },
        )

        // Ensure host cookie is NOT there
        await expect(page.locator("#logs")).not.toContainText(
            /FAIL: Host cookie visible/,
        )
    })

    test("cannot escape to host via outer-frame script injection", async ({
        page,
    }) => {
        await page.goto("/")

        await expect(page.locator("#sandbox-status")).toContainText("Ready", {
            timeout: 10000,
        })

        await page.click('button:has-text("Clear Logs")')
        await page.locator("#code").fill(`
            // Test 1: Try to access outer-frame (should work - same sandbox origin)
            try {
                const outerDoc = window.parent.document;
                console.log("Outer-frame access: " + (outerDoc ? "YES" : "NO"));
            } catch (e) {
                console.log("Outer-frame access: BLOCKED - " + e.message);
            }

            // Test 2: Try to access window.top.document (should fail - cross-origin)
            try {
                const topDoc = window.top.document;
                const topTitle = topDoc.title;
                console.error("FAIL: HOST ESCAPE - accessed window.top.document: " + topTitle);
            } catch (e) {
                console.log("PASS: window.top.document blocked - " + e.name);
            }

            // Test 3: Inject script into outer-frame, try to access host from there
            try {
                const script = window.parent.document.createElement('script');
                script.textContent = \`
                    try {
                        const hostDoc = window.top.document;
                        window.parent.postMessage({type:'LOG', source:'outer', level:'error', area:'security',
                            message:'FAIL: HOST ESCAPE from injected script'}, '*');
                    } catch (e) {
                        window.parent.postMessage({type:'LOG', source:'outer', level:'log', area:'security',
                            message:'PASS: Injected script blocked from host - ' + e.name}, '*');
                    }
                \`;
                window.parent.document.body.appendChild(script);
            } catch (e) {
                console.log("Script injection failed: " + e.message);
            }
        `)
        await page.click('button:has-text("Run Code")')

        // Wait for logs
        await page.waitForTimeout(1000)

        // Verify outer-frame is accessible (same origin)
        await expect(page.locator("#logs")).toContainText(
            /Outer-frame access: YES/,
        )

        // Verify host is NOT accessible
        await expect(page.locator("#logs")).toContainText(
            /PASS: window\.top\.document blocked/,
        )

        // Verify injected script also cannot access host
        await expect(page.locator("#logs")).toContainText(
            /PASS: Injected script blocked from host/,
        )

        // Ensure no escape happened
        await expect(page.locator("#logs")).not.toContainText(/HOST ESCAPE/)
    })

    test("no infrastructure functions exposed on window.parent", async ({
        page,
    }) => {
        await page.goto("/")

        await expect(page.locator("#sandbox-status")).toContainText("Ready", {
            timeout: 10000,
        })

        await page.click('button:has-text("Clear Logs")')
        await page.locator("#code").fill(`
            // Check for exposed infrastructure elements
            const exposedItems = [];

            // Check for known critical functions/variables that should NOT be exposed
            const forbidden = [
                'updateSandboxAttributes',
                'sendStatus',
                'checkState',
                'statusEl',
                'HOST_ORIGIN',
                'innerFrame'
            ];

            for (const name of forbidden) {
                if (typeof window.parent[name] !== 'undefined') {
                    exposedItems.push(name);
                }
            }

            // Also check via window.top[0] path
            try {
                if (typeof window.top[0]?.updateSandboxAttributes === 'function') {
                    exposedItems.push('window.top[0].updateSandboxAttributes');
                }
            } catch (e) {
                // Cross-origin blocked - good
            }

            if (exposedItems.length > 0) {
                console.error("FAIL: Exposed items: " + exposedItems.join(", "));
            } else {
                console.log("PASS: No infrastructure exposed on window.parent");
            }
        `)
        await page.click('button:has-text("Run Code")')

        await expect(page.locator("#logs")).toContainText(
            /PASS: No infrastructure exposed/,
            { timeout: 5000 },
        )

        await expect(page.locator("#logs")).not.toContainText(
            /FAIL: Exposed items/,
        )
    })

    test("iframe injection to external origin is blocked", async ({ page }) => {
        await page.goto("/")

        await expect(page.locator("#sandbox-status")).toContainText("Ready", {
            timeout: 10000,
        })

        await page.click('button:has-text("Clear Logs")')
        await page.locator("#code").fill(`
            // Try to create an iframe pointing to external origin
            const iframe = document.createElement('iframe');
            iframe.src = 'https://example.com';
            iframe.id = 'injected-iframe';
            document.body.appendChild(iframe);

            // Wait for iframe to attempt load, then check if we can access it
            setTimeout(() => {
                const injected = document.getElementById('injected-iframe');
                try {
                    // Try to access the iframe's document
                    // If CSP blocked it or it's cross-origin, this will throw
                    const doc = injected.contentDocument;
                    const body = doc?.body?.innerHTML;
                    if (body && body.length > 0) {
                        console.error("FAIL: Could read iframe content");
                    } else {
                        console.log("PASS: Iframe content not accessible");
                    }
                } catch (e) {
                    // SecurityError means cross-origin/blocked - this is expected
                    console.log("PASS: Iframe access blocked - " + e.name);
                }
            }, 2000);
        `)
        await page.click('button:has-text("Run Code")')

        // Wait for the timeout in the code
        await page.waitForTimeout(3000)

        // Should see blocked/inaccessible message
        await expect(page.locator("#logs")).toContainText(
            /PASS:.*blocked|not accessible/i,
            { timeout: 5000 },
        )

        // Should NOT be able to read content
        await expect(page.locator("#logs")).not.toContainText(
            /FAIL: Could read iframe content/,
        )
    })
})

// ============================================================================
// Test: Local HTML Preset
// ============================================================================
// SKIPPED: Iframe loading timeouts in CI (origin/network aliasing).
test.describe.skip("Local HTML Preset", () => {
    test("can fetch and render local HTML page", async ({ page }) => {
        await page.goto("/")

        const preset = PRESETS.localHtml
        await setupSandbox(page, preset.rules)

        // Wait for READY then execute
        await executeAndWaitForLog(
            page,
            preset.code,
            /HTML loaded, rendering content/,
        )

        // Verify the HTML content was actually rendered into the sandbox
        // Piercing shadow DOM: safe-sandbox -> shadow-root -> iframe#sandbox -> iframe#inner
        const innerFrame = page
            .locator("safe-sandbox#sandbox")
            .frameLocator("iframe#sandbox")
            .frameLocator("iframe#inner")

        // Wait for surgical rendering to complete
        await page.waitForTimeout(3000)

        // Check for content from test-page.html
        // test-page.html has <h1>Sandbox Test Page</h1>
        await expect(innerFrame.locator("h1")).toHaveText("Sandbox Test Page", {
            timeout: 10000,
        })

        // Check for logs from scripts in test-page.html
        await expect(page.locator("#logs")).toContainText(
            /Script loaded successfully!/,
        )
    })
})
