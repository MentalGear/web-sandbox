/**
 * CSP Firewall
 * Generates the Content Security Policy headers for the sandbox.
 */

export function generateCSP(
    allowParam: string,
    port: number,
    scriptUnsafe: boolean = false,
): string {
    // Parse allowed domains from query string
    const allowedDomains = allowParam
        ? allowParam
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean)
        : []

    // Build allowed origins list for multiple directives
    const allowedOrigins = [
        "'self'",
        ...allowedDomains.map((d) => {
            if (d.startsWith("http")) return d

            // Handle localhost and 127.0.0.1 specially to support local dev protocols (HTTP/HTTPS/Ports)
            if (
                d === "localhost" ||
                d.startsWith("localhost:") ||
                d === "127.0.0.1" ||
                d.startsWith("127.0.0.1:")
            ) {
                const base = `http://${d} https://${d}`
                const portSuffix = port ? `:${port}` : ""
                // If no port specified in allowed list, also allow the current server port
                if (!d.includes(":") && portSuffix) {
                    return `${base} http://${d}${portSuffix} https://${d}${portSuffix}`
                }
                return base
            }
            return `https://${d}`
        }),
    ].join(" ")

    // CSP: Allow eval (for user code), inline images/scripts/styles from allowed domains
    // This is the core "Firewall" that prevents exfiltration to unauthorized domains
    const scriptDirectives = scriptUnsafe
        ? `'self' 'unsafe-inline' 'unsafe-eval' ${allowedOrigins}`
        : `'self' ${allowedOrigins}`

    return (
        `default-src 'self'; ` +
        `script-src ${scriptDirectives}; ` +
        `img-src 'self' data: ${allowedOrigins}; ` +
        `style-src 'self' 'unsafe-inline'; ` +
        // Defense-in-depth: Block <base> tag manipulation
        `base-uri 'self'; ` +
        `connect-src ${allowedOrigins};`
    )
}
