/**
 * Shared Type Definitions for SafeSandbox
 */

export interface NetworkRules {
    // Network Firewall (Service Worker)
    allow?: string[]
    allowProtocols?: ("http" | "https")[]
    allowMethods?: string[]
    maxContentLength?: number
    proxyUrl?: string
    files?: Record<string, string>
    cacheStrategy?: "network-first" | "cache-first" | "network-only"
    scriptUnsafe?: boolean // Allow 'unsafe-inline' and 'unsafe-eval'

    // Execution Firewall (iframe sandbox attribute)
    execution?: ExecutionPolicy
}

export interface ExecutionPolicy {
    scripts?: boolean // allow-scripts (default: true)
    formSending?: boolean // allow-forms (default: true)
    popups?: boolean // allow-popups (default: false)
    modals?: boolean // allow-modals (default: true)
    downloads?: boolean // allow-downloads (default: false)
}

export interface LogMessage {
    type: "LOG"
    timestamp: number
    source: "outer" | "inner"
    level: "log" | "warn" | "error"
    area?: "network" | "security" | "user-code"
    message: string
    data?: Record<string, unknown>
}
