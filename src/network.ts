/**
 * Public entry point of the package built with the network modes (`WEB_SANDBOX_NETWORK_MODES=1 bun run build:lib`;
 * ADR-009): everything the default build exports (sealed.ts), with strict, cooperative and worker mode, `origins` and
 * `fetchBridge` installed into the element as this module is imported, and their types and values exported.
 * Importing it registers no element: call defineWebSandbox() (optionally with your own tag name).
 */
import { installNetworkModes } from "./lib/network-install";

installNetworkModes();

export * from "./sealed";
export type { CooperativeSandboxConfig, NetworkModeEvents, NetworkModeMethods, NetworkSandboxOptions, StrictSandboxConfig, WorkerSandboxConfig } from "./lib/network-types";
export type { SandboxOrigins, StrictSandboxOrigins } from "./lib/csp/origins";
export type { FetchBridgeConfig, FetchErrorCode, FetchRecord } from "./lib/fetch-bridge";
export { FETCH_ERROR_CODES } from "./lib/fetch-bridge";
export { UNSAFE_CAPABILITIES, UNSAFE_SANDBOX_FLAGS, UNSAFE_PERMISSIONS } from "./csp-directives";
export type { UnsafeCapability, UnsafePermission, SandboxCapability } from "./csp-directives";
