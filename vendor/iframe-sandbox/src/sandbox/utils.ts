/**
 * Sandbox Utilities
 * Helpers for safe data serialization and messaging.
 */

/**
 * Safely extracts metadata from an object for transmission via postMessage.
 * Handles circular references, DOM nodes, and Error objects to prevent cloning errors.
 *
 * @param arg The value to process
 * @param depth Current recursion depth (internal)
 * @param seen Set of visited objects to detect cycles (internal)
 * @returns A safe, cloneable representation of the input
 */
export function extractMetadata(
    arg: any,
    depth = 0,
    seen = new WeakSet(),
): any {
    if (arg === null || arg === undefined) return String(arg)
    const type = typeof arg

    // Primitives pass through
    if (type !== "object" && type !== "function") return arg

    // Limit depth to prevent stack overflow on deep structures
    if (depth > 3) return "[Max Depth]"

    // Handle Functions
    if (type === "function") return `[Function: ${arg.name || "anonymous"}]`

    // Handle Errors (Error objects don't clone standard properties well)
    const ctorName = arg.constructor?.name || "Object"
    if (ctorName.includes("Error")) {
        return {
            _type: "Error",
            name: arg.name,
            message: arg.message,
            stack: arg.stack,
        }
    }

    // Handle DOM Nodes
    if (arg.nodeType && arg.nodeName) return `[DOM: ${arg.nodeName}]`

    // Handle Circular References
    if (seen.has(arg)) return "[Circular]"

    seen.add(arg)

    // Handle Arrays
    if (Array.isArray(arg)) {
        return arg.map((item) => extractMetadata(item, depth + 1, seen))
    }

    // Handle Objects
    const result: Record<string, any> = {}
    try {
        for (const key in arg) {
            if (Object.prototype.hasOwnProperty.call(arg, key)) {
                result[key] = extractMetadata(arg[key], depth + 1, seen)
            }
        }
    } catch (e) {
        return "[Unextractable]"
    }

    return result
}

/**
 * creates a standard log message structure
 */
export function createLogMessage(
    level: "log" | "warn" | "error",
    message: string,
    data = {},
) {
    return {
        type: "LOG",
        timestamp: Date.now(),
        source: "inner",
        level,
        area: "user-code",
        message,
        data,
    }
}
