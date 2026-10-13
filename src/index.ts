/**
 * Public entry point of the package.
 * Importing it registers nothing: call defineWebSandbox() (optionally with your own tag name).
 */
export { WebSandbox, defineWebSandbox } from "./host";
export type { SandboxConfig, SandboxState } from "./host";
export type { RpcError, RpcErrorCode } from "./lib/rpc";
export type { SandboxViolation } from "./lib/violation";
export { VIOLATION_EVENT_LIMIT } from "./lib/violation";
export { AUTO_RESIZE_MAX_HEIGHT, AUTO_RESIZE_MAX_UPDATES_PER_SECOND } from "./lib/auto-resize";
export type { FetchBridgeConfig, FetchErrorCode, FetchRecord } from "./lib/fetch-bridge";
export { FETCH_ERROR_CODES } from "./lib/fetch-bridge";
export type { FileContent, FileEntry, FileInfo, FileError, FileErrorCode, SandboxFiles } from "./lib/files";

export {
    SAFE_CAPABILITIES,
    UNSAFE_CAPABILITIES,
    UNSAFE_SANDBOX_FLAGS,
    UNSAFE_PERMISSIONS,
} from "./csp-directives";
export type {
    CSPDirectives,
    SafeCapability,
    UnsafeCapability,
    UnsafePermission,
    SandboxCapability,
} from "./csp-directives";

export { SandboxDevTools } from "./devtools";
