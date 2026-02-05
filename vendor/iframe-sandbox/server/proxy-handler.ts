/**
 * Proxy Handler - CORS proxy for external resources
 * Shared by both host and sandbox origins.
 */

export async function handleProxyRequest(
    req: Request,
    url: URL,
): Promise<Response> {
    // PROXY DISABLED
    // The following implementation is disabled as we currently do not support
    // general-purpose proxying due to security and complexity concerns.

    return new Response("Proxy is not currently supported.", {
        status: 501, // Not Implemented
        statusText: "Not Implemented",
    })

    /*
    const targetUrl = url.searchParams.get("url")

    const corsHeaders = new Headers()
    const origin = req.headers.get("origin")
    // Simple check - in production you'd want robust config-based matching
    if (
        origin &&
        (origin.includes("localhost") || origin.includes("127.0.0.1"))
    ) {
        corsHeaders.set("Access-Control-Allow-Origin", origin)
    }
    corsHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    corsHeaders.set("Access-Control-Allow-Headers", "*")

    // Handle preflight
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders })
    }

    if (!targetUrl) {
        return new Response("Missing url parameter", {
            status: 400,
            headers: corsHeaders,
        })
    }

    console.log(`[Proxy] Fetching: ${targetUrl}`)

    try {
        const proxyRes = await fetch(targetUrl)
        const resHeaders = new Headers(proxyRes.headers)

        // Remove problematic headers
        resHeaders.delete("content-encoding")
        resHeaders.delete("content-length")
        resHeaders.delete("transfer-encoding")
        resHeaders.delete("connection")

        // Secure CORS: Only allow trusted origins
        // Prevents Open Proxy / SSRF abuse from other sites
        const origin = req.headers.get("origin")
        const allowedOrigins = [
            `http://localhost:${url.searchParams.get("port") || "3333"}`,
            `http://127.0.0.1:${url.searchParams.get("port") || "3333"}`,
            `http://sandbox.localhost:${url.searchParams.get("port") || "3333"}`,
        ]

        if (origin && allowedOrigins.some((o) => origin.startsWith(o))) {
            resHeaders.set("Access-Control-Allow-Origin", origin)
        }

        return new Response(proxyRes.body, {
            status: proxyRes.status,
            statusText: proxyRes.statusText,
            headers: resHeaders,
        })
    } catch (e: any) {
        return new Response(`Proxy Error: ${e.message}`, {
            status: 502,
            headers: corsHeaders,
        })
    }
    */
}
