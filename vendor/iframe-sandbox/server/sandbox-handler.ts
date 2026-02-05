import { join } from "path"

/**
 * Sandbox Handler - Minimal file exposure
 * Only serves the files needed for sandbox infrastructure.
 */

const SANDBOX_ROOT = join(process.cwd(), "src/sandbox")

// Fallback CSP if not handled by Session logic
const SANDBOX_CSP = "default-src 'self';"

export async function handleSandboxRequest(
    req: Request,
    url: URL,
): Promise<Response> {
    const path = url.pathname

    // Only these routes are allowed
    let filePath: string
    let isTypeScript = false

    if (path === "/inner-frame.html" || path === "/") {
        filePath = join(SANDBOX_ROOT, "inner-frame.html")
    } else if (path === "/inner-frame.js") {
        filePath = join(SANDBOX_ROOT, "inner-frame.ts")
        isTypeScript = true
    } else if (path === "/utils.js") {
        filePath = join(SANDBOX_ROOT, "utils.ts")
        isTypeScript = true
    } else {
        // Block everything else
        return new Response("Not Found", { status: 404 })
    }

    const file = Bun.file(filePath)
    if (!(await file.exists())) {
        return new Response("Not Found", { status: 404 })
    }

    const headers: Record<string, string> = {
        "Content-Type": file.type,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Content-Security-Policy": SANDBOX_CSP,
    }

    // Transpile TypeScript for browser
    if (isTypeScript) {
        headers["Content-Type"] = "application/javascript"
        headers["Cache-Control"] = "no-store, no-cache, must-revalidate"

        const result = await Bun.build({
            entrypoints: [filePath],
            target: "browser",
            format: "esm",
        })

        if (result.success && result.outputs.length > 0) {
            const jsCode = await result.outputs[0].text()
            return new Response(jsCode, { headers })
        } else {
            console.error("[Sandbox] Build failed:", result.logs)
            return new Response("Build Error", { status: 500 })
        }
    }

    return new Response(file as any, { headers })
}
