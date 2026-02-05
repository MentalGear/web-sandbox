import { join } from "path"

/**
 * Host Handler - Development server routes
 * Serves playground UI and library files.
 */

const PROJECT_ROOT = process.cwd()
const SANDBOX_HOST = `sandbox.${process.env.HOST || "localhost"}`
const PORT = parseInt(process.env.PORT || "3333", 10)

export async function handleHostRequest(
    req: Request,
    url: URL,
): Promise<Response> {
    let path = url.pathname

    // Route mapping
    if (path === "/") {
        path = "/playground/index.html"
    } else if (!path.startsWith("/playground/") && !path.startsWith("/src/")) {
        // Default to playground for unknown paths
        path = "/playground" + path
    }

    // Security: block path traversal
    if (path.includes("..")) {
        return new Response("Forbidden", { status: 403 })
    }

    const relPath = path.startsWith("/") ? path.slice(1) : path
    const filePath = join(PROJECT_ROOT, relPath)
    const file = Bun.file(filePath)

    if (!(await file.exists())) {
        console.log(`[Host] 404: ${path}`)
        return new Response("Not Found", { status: 404 })
    }

    // Handle CORS for Unique Sandbox Origins
    const origin = req.headers.get("origin")
    let allowOrigin = `http://${SANDBOX_HOST}:${PORT}` // Default fallback

    if (origin) {
        // Allow any *.sandbox.localhost:PORT
        // Regex: ^http://[a-zA-Z0-9-]+\.sandbox\.localhost:3333$
        const sandboxRegex = new RegExp(`^http://[a-zA-Z0-9-]+\\.${SANDBOX_HOST.replace('.', '\\.')}:${PORT}$`);
        if (sandboxRegex.test(origin) || origin === `http://${SANDBOX_HOST}:${PORT}`) {
            allowOrigin = origin;
        }
    }

    const headers: Record<string, string> = {
        "Content-Type": file.type,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": allowOrigin,
        "Vary": "Origin"
    }

    // Transpile TypeScript for browser
    if (path.endsWith(".ts")) {
        headers["Content-Type"] = "application/javascript"

        const result = await Bun.build({
            entrypoints: [filePath],
            target: "browser",
            format: "esm",
        })

        if (result.success && result.outputs.length > 0) {
            const jsCode = await result.outputs[0].text()

            // Host CSP - Update to allow unique origins in frame-src if needed?
            // Actually, Host loads Outer Frame (gone) or Inner Frame directly.
            // If Host is just UI, it doesn't iframe them?
            // playground/security.html has <safe-sandbox>.
            // safe-sandbox creates iframe to [uuid].sandbox.localhost.
            // So Host CSP 'frame-src' must allow [uuid].sandbox.localhost.

            // Wildcards in CSP: http://*.sandbox.localhost:3333
            const sandboxWildcard = `http://*.${SANDBOX_HOST}:${PORT}`;

            headers["Content-Security-Policy"] =
                `default-src 'self' ${sandboxWildcard}; ` +
                `script-src 'self' 'unsafe-inline'; ` +
                `style-src 'self' 'unsafe-inline'; ` +
                `frame-src ${sandboxWildcard};`

            return new Response(jsCode, { headers })
        } else {
            console.error("[Host] Build failed:", result.logs)
            return new Response("Build Error", { status: 500 })
        }
    }

    // Host CSP for non-TS files
    const sandboxWildcard = `http://*.${SANDBOX_HOST}:${PORT}`;
    headers["Content-Security-Policy"] =
        `default-src 'self' ${sandboxWildcard}; ` +
        `script-src 'self' 'unsafe-inline'; ` +
        `style-src 'self' 'unsafe-inline'; ` +
        `frame-src ${sandboxWildcard};`

    return new Response(file as any, { headers })
}
