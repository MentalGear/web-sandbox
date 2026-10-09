// Capabilities that keep the guest inside the frame and its network policy.
// allow-forms is safe because form-action defaults to 'none' and the wrapper frame blocks
// the guest frame from navigating (which is what a form submission does).
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
export const UNSAFE_SANDBOX_FLAGS = [
    "allow-downloads",
    "allow-modals",
    "allow-popups",
    "allow-presentation",
] as const;

// Not sandbox flags: these are Permissions Policy features, granted through the iframe `allow` attribute.
// - fullscreen: a fullscreen guest can draw fake browser UI (phishing). Browsers require a user gesture
//   to enter fullscreen and show an exit hint.
export const UNSAFE_PERMISSIONS = [
    "fullscreen",
] as const;

export const UNSAFE_CAPABILITIES = [...UNSAFE_SANDBOX_FLAGS, ...UNSAFE_PERMISSIONS] as const;

// Everything that may end up in the sandbox attribute
export const ALLOWED_CAPABILITIES = [...SAFE_CAPABILITIES, ...UNSAFE_SANDBOX_FLAGS] as const;

export type SafeCapability = (typeof SAFE_CAPABILITIES)[number];
export type UnsafeCapability = (typeof UNSAFE_CAPABILITIES)[number];
export type UnsafePermission = (typeof UNSAFE_PERMISSIONS)[number];
export type SandboxCapability = (typeof ALLOWED_CAPABILITIES)[number];

export interface CSPDirectives {
    "upgrade-insecure-requests": true;
    "default-src"?: string[];
    "script-src"?: string[];
    "connect-src"?: string[];
    "base-uri"?: string[];
    "img-src"?: string[];
    "style-src"?: string[];
    "font-src"?: string[];
    "media-src"?: string[];
    "manifest-src"?: string[];
    "prefetch-src"?: string[];
    "form-action"?: string[];
    "object-src"?: string[]; // <embed, <object, ...
    "frame-src"?: string[]; // specifies sources where iframes in this page can be loaded from
    "frame-ancestors"?: string[]; // specifies parent sources that are allowed to embed this page using <frame>, <iframe>, <object>, or <embed>
    "worker-src"?: string[]; // 'blob' or 'data' might be needed for frontend-frameworks to spawn workers
}
