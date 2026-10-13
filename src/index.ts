/**
 * Public entry point of the package.
 * Importing it registers nothing: call defineWebSandbox() (optionally with your own tag name).
 */
export { WebSandbox, defineWebSandbox } from "./host";
export type { SandboxConfig, SandboxState } from "./host";
export type { RpcError, RpcErrorCode } from "./lib/rpc";
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
