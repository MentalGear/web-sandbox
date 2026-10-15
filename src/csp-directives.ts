// The capabilities (sandbox flags and Permissions Policy features) an embedder can grant the guest. Its network
// policy is `origins` (src/lib/csp/origins.ts).
// allow-forms is safe because form-action defaults to 'none' and the wrapper frame blocks
// the guest frame from navigating (which is what a form submission does).
/** The values `capabilities` accepts: sandbox flags that keep the guest inside the frame. */
export const SAFE_CAPABILITIES = [
    "allow-forms",
    "allow-orientation-lock",
    "allow-pointer-lock",
    "allow-scripts",
] as const;

// Capabilities that reach outside the frame, so they need an explicit opt-in via `unsafeCapabilities`:
// - allow-popups: a popup is a new top-level window, untouched by the frame's CSP -> URL exfiltration
// - allow-modals: alert/confirm/prompt can imitate host UI and block the host's main thread
// - allow-downloads: writes files to the user's disk
// - allow-presentation: the Presentation API opens a URL on a second screen, outside the frame's CSP
/** The sandbox flags among UNSAFE_CAPABILITIES. */
export const UNSAFE_SANDBOX_FLAGS = [
    "allow-downloads",
    "allow-modals",
    "allow-popups",
    "allow-presentation",
] as const;

// Not sandbox flags: these are Permissions Policy features, granted through the iframe `allow` attribute.
// - fullscreen: a fullscreen guest can draw fake browser UI (phishing). Browsers require a user gesture
//   to enter fullscreen and show an exit hint.
/** The Permissions Policy features among UNSAFE_CAPABILITIES, granted through the frames' `allow` attribute. */
export const UNSAFE_PERMISSIONS = [
    "fullscreen",
] as const;

/** The values `unsafeCapabilities` accepts: each reaches outside the frame and warns once when enabled. */
export const UNSAFE_CAPABILITIES = [...UNSAFE_SANDBOX_FLAGS, ...UNSAFE_PERMISSIONS] as const;

// Everything that may end up in the sandbox attribute
export const ALLOWED_CAPABILITIES = [...SAFE_CAPABILITIES, ...UNSAFE_SANDBOX_FLAGS] as const;

export type SafeCapability = (typeof SAFE_CAPABILITIES)[number];
export type UnsafeCapability = (typeof UNSAFE_CAPABILITIES)[number];
export type UnsafePermission = (typeof UNSAFE_PERMISSIONS)[number];
export type SandboxCapability = (typeof ALLOWED_CAPABILITIES)[number];
