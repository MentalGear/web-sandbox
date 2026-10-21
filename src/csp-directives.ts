// The capabilities (sandbox flags and Permissions Policy features) an embedder can grant the guest. Its network
// policy is `origins` (src/lib/csp/origins.ts).
/** The values the `capabilities` option accepts: sandbox flags that keep the guest inside the frame. */
export const SAFE_CAPABILITIES = [
    "allow-orientation-lock",
    "allow-scripts",
] as const;

// Capabilities that reach outside the frame, so they need an explicit opt-in via `unsafeCapabilities`:
// - allow-forms: a submission is a navigation, and inside the frame form-action 'none' and the wrapper frame stop it.
//   But a submit button clicked with a modifier, by the user or by a click the guest's own script synthesizes, opens
//   the submission in a new top-level tab, and Chromium checks no form-action for it: the form's fields reach any URL
//   (R1:R2-2). It is opt-in for that reason; strict mode always sets it on its view, where no guest script runs and
//   every submit is cancelled (host.ts, _getSandboxFlags), so strict mode is unaffected.
// - allow-popups: a popup is a new top-level window, untouched by the frame's CSP -> URL exfiltration. Leaving it
//   out does not stop every new window in cooperative mode: a modifier click on a guest link opens one (R1:R2-2, a
//   cooperative-mode limit)
// - allow-modals: alert/confirm/prompt can imitate host UI and block the host's main thread
// - allow-downloads: writes files to the user's disk
// - allow-pointer-lock: a guest can hide the cursor and capture relative input, so it can draw its own cursor and fake
//   host UI (the UI-spoofing reasoning of fullscreen below); browsers require a user gesture to lock and show an exit hint
// - allow-presentation: the Presentation API opens a URL on a second screen, outside the frame's CSP
/** The sandbox flags among {@link UNSAFE_CAPABILITIES}: each reaches outside the frame and needs an explicit opt-in. */
export const UNSAFE_SANDBOX_FLAGS = [
    "allow-downloads",
    "allow-forms",
    "allow-modals",
    "allow-pointer-lock",
    "allow-popups",
    "allow-presentation",
] as const;

// Not sandbox flags: these are Permissions Policy features, granted through the iframe `allow` attribute.
// - fullscreen: a fullscreen guest can draw fake browser UI (phishing). Browsers require a user gesture
//   to enter fullscreen and show an exit hint.
/** The Permissions Policy features among {@link UNSAFE_CAPABILITIES}, granted through the frames' `allow` attribute. */
export const UNSAFE_PERMISSIONS = [
    "fullscreen",
] as const;

/** The values the `unsafeCapabilities` option accepts: each reaches outside the frame and warns once when enabled. */
export const UNSAFE_CAPABILITIES = [...UNSAFE_SANDBOX_FLAGS, ...UNSAFE_PERMISSIONS] as const;

/**
 * Everything that may end up in the sandbox attribute: the members of SandboxCapability.
 * @internal
 */
export const ALLOWED_CAPABILITIES = [...SAFE_CAPABILITIES, ...UNSAFE_SANDBOX_FLAGS] as const;

/** A member of {@link SAFE_CAPABILITIES}: an entry of the `capabilities` option. */
export type SafeCapability = (typeof SAFE_CAPABILITIES)[number];
/** A member of {@link UNSAFE_CAPABILITIES}: an entry of the `unsafeCapabilities` option. */
export type UnsafeCapability = (typeof UNSAFE_CAPABILITIES)[number];
/** A member of {@link UNSAFE_PERMISSIONS}: a capability granted through the frames' `allow` attribute, not a sandbox flag. */
export type UnsafePermission = (typeof UNSAFE_PERMISSIONS)[number];
// ALLOWED_CAPABILITIES's members, derived from the two public lists it joins, so the public type names no internal value.
/**
 * A value that may end up in a frame's `sandbox` attribute: a {@link SafeCapability} or a member of
 * {@link UNSAFE_SANDBOX_FLAGS}.
 */
export type SandboxCapability = SafeCapability | (typeof UNSAFE_SANDBOX_FLAGS)[number];
