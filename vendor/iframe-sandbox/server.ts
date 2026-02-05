import { serve } from "bun"
import { handleSandboxRequest } from "./server/sandbox-handler"
import { handleHostRequest } from "./server/host-handler"
import { generateCSP } from "./server/csp-firewall"
import crypto from "crypto"

/**
 * SafeSandbox Development Server
 * Routes requests to appropriate handlers based on subdomain.
 */

const PORT = parseInt(process.env.PORT || "3333", 10)
const HOST = process.env.HOST || "localhost"

// Session Storage (In-Memory)
// Map<sessionId, SessionConfig>
interface SessionConfig {
    allow: string; // CSV allowed domains
    unsafe: boolean;
}
const sessions = new Map<string, SessionConfig>();

console.log(`Server running at:`)
console.log(`- Host:    http://${HOST}:${PORT}`)
console.log(`- Sandbox: http://*.sandbox.${HOST}:${PORT}`)

serve({
    port: PORT,
    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url)
        const hostHeader = req.headers.get("host") || ""

        // Host API for creating sessions
        if (hostHeader === `${HOST}:${PORT}` || hostHeader === HOST) {
            if (url.pathname === "/api/session" && req.method === "POST") {
                try {
                    const body = await req.json();
                    const sessionId = crypto.randomUUID();
                    sessions.set(sessionId, {
                        allow: body.allow || "",
                        unsafe: !!body.unsafe
                    });

                    return new Response(JSON.stringify({ sessionId }), {
                        headers: { "Content-Type": "application/json" }
                    });
                } catch (e) {
                    return new Response("Bad Request", { status: 400 });
                }
            }
            return handleHostRequest(req, url)
        }

        // Sandbox Requests
        // Check for [uuid].sandbox.localhost

        const sandboxMatch = hostHeader.match(/^([a-f0-9-]+)\.sandbox\./);
        const isLegacySandbox = hostHeader.startsWith("sandbox.");

        if (sandboxMatch) {
            const sessionId = sandboxMatch[1];
            const session = sessions.get(sessionId);

            if (!session) {
                return new Response("Invalid Session ID", { status: 404 });
            }

            // Serve inner-frame.html with Session-based CSP
             if (
                url.pathname === "/inner-frame.html" ||
                url.pathname === "/" ||
                url.pathname === "/index.html"
            ) {
                const filePath = "./src/sandbox/inner-frame.html"
                const file = Bun.file(filePath)

                // Use Session Config for CSP
                const csp = generateCSP(session.allow, PORT, session.unsafe)

                return new Response(file, {
                    headers: {
                        "Content-Type": "text/html",
                        "Content-Security-Policy": csp,
                        "Cache-Control": "no-store",
                    },
                })
            }
            return handleSandboxRequest(req, url)

        } else if (isLegacySandbox) {
            return new Response("Unique Origin Required (Start session via Host API)", { status: 403 });
        }

        return new Response("Not Found", { status: 404 });
    },
})
