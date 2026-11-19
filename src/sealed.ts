/**
 * The public API of sealed mode: what every build of the package exports. The default build's entry (index.ts) exports
 * exactly this; the network build's (network.ts) adds the network modes' types and values (ADR-009).
 * Importing it registers nothing: call defineWebSandbox() with the URL of the served file (and optionally a tag name).
 */
export { WebSandbox, defineWebSandbox, EXECUTION_TIMEOUT_GRACE_MS, LOAD_TIMEOUT_MS, VIEW_LIVENESS_TIMEOUT_MS } from "./host";
export type {
    CallLimits,
    HostMethod,
    SandboxApp,
    SandboxConfig,
    SandboxConfigByMode,
    SandboxConfigOptions,
    SandboxGrants,
    SandboxState,
    SealedSandboxConfig,
    SealedSandboxDefinition,
    WebSandboxDefinition,
    WebSandboxDefinitionByBuild,
    WebSandboxEventMap,
} from "./host";
export type { RpcError, RpcErrorCode, RpcLibraryCode } from "./lib/rpc";
export { MAX_INBOUND_IN_FLIGHT } from "./lib/rpc";
export type { SandboxLog, SandboxLogLevel } from "./lib/sandbox-log";
export { LOG_EVENTS_PER_SECOND, LOG_MAX_ARGS, LOG_MAX_STRING } from "./lib/sandbox-log";
export type { SandboxViolation } from "./lib/violation";
export { VIOLATION_EVENT_LIMIT } from "./lib/violation";
export { AUTO_RESIZE_MAX_HEIGHT, AUTO_RESIZE_MAX_UPDATES_PER_SECOND } from "./lib/auto-resize";
export { VIEW_INPUT_IN_FLIGHT, VIEW_RENDER_MAX_LENGTH, VIEW_SET_STYLE_LIMITS, VIEW_STYLE_PROPERTIES, viewScriptHash } from "./lib/in-sandbox-view";
export type { FileContent, FileEntry, FileInfo, FileError, FileErrorCode, SandboxFiles } from "./lib/files";
export type { GuestWrite } from "./lib/guest-writes";
export { GUEST_WRITES_PER_SECOND, GUEST_WRITE_BYTES_PER_SECOND } from "./lib/guest-writes";
export { LINK_TABS_PER_SECOND, MAX_LINKS } from "./lib/links";
export type { GuestBytes, GuestImageType } from "./lib/guest-bytes";
export { GUEST_IMAGE_TYPES } from "./lib/guest-bytes";

export { SAFE_CAPABILITIES } from "./csp-directives";
export type { SafeCapability } from "./csp-directives";

export { SandboxDevTools } from "./devtools";
