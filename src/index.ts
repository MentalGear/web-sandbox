/**
 * Public entry point of the package.
 * Importing it registers nothing: call defineWebSandbox() (optionally with your own tag name).
 */
export { WebSandbox, defineWebSandbox } from "./host";
export type { SandboxConfig } from "./host";

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
