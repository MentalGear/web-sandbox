/**
 * Public entry point of the package.
 * Importing it registers nothing: call defineWebSandbox() (optionally with your own tag name).
 */
export { WebSandbox, defineWebSandbox, EXECUTION_TIMEOUT_GRACE_MS, LOAD_TIMEOUT_MS, VIEW_LIVENESS_TIMEOUT_MS } from "./host";
export type { CallLimits, SandboxConfig, SandboxState } from "./host";
export type { SandboxOrigins, StrictSandboxOrigins } from "./lib/csp/origins";
export type { RpcError, RpcErrorCode } from "./lib/rpc";
export { MAX_INBOUND_IN_FLIGHT } from "./lib/rpc";
export type { SandboxLog, SandboxLogLevel } from "./lib/sandbox-log";
export { LOG_EVENTS_PER_SECOND, LOG_MAX_ARGS, LOG_MAX_STRING } from "./lib/sandbox-log";
export type { SandboxViolation } from "./lib/violation";
export { VIOLATION_EVENT_LIMIT } from "./lib/violation";
export { AUTO_RESIZE_MAX_HEIGHT, AUTO_RESIZE_MAX_UPDATES_PER_SECOND } from "./lib/auto-resize";
export { VIEW_RENDER_MAX_LENGTH, viewScriptHash } from "./lib/in-sandbox-view";
export type { FetchBridgeConfig, FetchErrorCode, FetchRecord } from "./lib/fetch-bridge";
export { FETCH_ERROR_CODES } from "./lib/fetch-bridge";
export type { FileContent, FileEntry, FileInfo, FileError, FileErrorCode, SandboxFiles } from "./lib/files";
export type { GuestWrite } from "./lib/guest-writes";
export { GUEST_WRITES_PER_SECOND, GUEST_WRITE_BYTES_PER_SECOND } from "./lib/guest-writes";

export {
    SAFE_CAPABILITIES,
    UNSAFE_CAPABILITIES,
    UNSAFE_SANDBOX_FLAGS,
    UNSAFE_PERMISSIONS,
} from "./csp-directives";
export type {
    SafeCapability,
    UnsafeCapability,
    UnsafePermission,
    SandboxCapability,
} from "./csp-directives";

export { SandboxDevTools } from "./devtools";
