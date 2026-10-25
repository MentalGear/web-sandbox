/**
 * The words of docs/API.md's Configuration table that the config schema (src/lib/config-schema.ts) does not hold: each
 * option's type and what it does. The option, its default and its modes come from CONFIG_SCHEMA (`documented`, `modes`).
 * The keys are the schema's options but the removed ones, so a new option fails to type-check here until it has a row;
 * the order is the table's. In `what`, `{safeCapabilities}` and `{unsafeCapabilities}` stand for the lists in
 * src/csp-directives.ts. Prose, edited here and rendered by extractors/config.ts.
 */
import type { OptionName, CONFIG_SCHEMA } from '../../../src/lib/config-schema';

export interface OptionWords {
    /** The Type cell, as Markdown. */
    readonly type: string;
    /** The Modes cell where it is not the schema's list (`mode` applies to every mode, and says so with a dash). */
    readonly modes?: string;
    /** Said after the schema's modes. */
    readonly modesNote?: string;
    /** The "What it does" cell, as Markdown. */
    readonly what: string;
}

type Documented = { [K in OptionName]: (typeof CONFIG_SCHEMA)[K] extends { readonly removed: string } ? never : K }[OptionName];

export const OPTION_WORDS: Record<Documented, OptionWords> = {
    mode: { type: "`'strict' | 'sealed' | 'cooperative' | 'worker'`", modes: '—',
        what: "Where guest code runs; see [Modes](#modes). `'sealed'`, the default, is strict mode with no network: a sealed config that names `origins` or `fetchBridge`, with the mode written or left out, is refused, and the sandbox terminates with the reason `` origins and fetchBridge open the network, which sealed mode (the default) does not have: set `mode: 'strict'` ``. To open the network, name `mode: 'strict'`. Any other value starts no environment: the sandbox terminates with the reason `unknown mode …` until a valid mode is configured. `'iframe'` was renamed `'cooperative'`: refused the same way, and the reason says so." },
    html: { type: "`string`",
        what: "The initial view (strict and sealed mode) or the guest document (cooperative mode). In strict and sealed mode its `<script>` elements and `on…` handler attributes never run, and markup that holds any warns once per element: ``sealed mode (the default) runs no script in `html`; …`` (in strict mode ``strict mode runs no script in `html`; …``). Empty means `<div id=\"root\"></div>`. Ignored in worker mode. Also set by [`load()`](#loadhtml)." },
    capabilities: { type: "`SafeCapability[]`",
        what: "Sandbox flags that keep the guest inside the frame: {safeCapabilities}. Anything else is dropped with a warning. Worker mode always adds `allow-scripts`; strict and sealed mode always have `allow-scripts allow-forms` (listing either there changes nothing)." },
    unsafeCapabilities: { type: "`UnsafeCapability[]`",
        what: "Capabilities that act outside the frame: {unsafeCapabilities}. Each one enabled warns once. `allow-forms` lets guest forms submit: `form-action 'none'` refuses the submission inside the frame, but one opened in a new tab by a modifier click (the user's, or one the guest's script synthesizes) is not checked against it in Chromium. `allow-pointer-lock` and `fullscreen` let a guest hide the cursor, capture relative input or draw over the whole screen, so each can imitate host or browser UI. `fullscreen` is granted as `allow=\"fullscreen *\"` (a Permissions Policy feature), the rest as sandbox flags. Dropped with a warning in strict and sealed mode. Without `allow-popups` guest code opens no window, but in cooperative mode the user's own Ctrl-, Shift- or middle-click, or Ctrl/Shift+Enter, on a guest link opens it in a new tab in Chromium and Firefox (platform behaviour of any sandboxed frame; see [Modes](#modes)). On Chromium the sandbox's frame is credentialless, so a popup that `allow-popups` lets the guest open has no opener: the guest's `window.open()` returns `null`, though the page opens." },
    scriptUnsafe: { type: "`boolean`",
        what: "Only a literal `true` enables it. Adds `'unsafe-eval'` to the guest policy (strings run as code; WebAssembly too) and enables [`execute()`](#executecode). For testing; warns once per element." },
    origins: { type: "`SandboxOrigins`", modesNote: " (strict: no `scripts`)",
        what: "The exact origins the guest may load each kind from: connections, images, styles, fonts, media, scripts. Not in sealed mode: a sealed config that names it is refused. See [below](#origins)." },
    hostContentSecurityPolicy: { type: "`string | false`",
        what: "Your page's Content-Security-Policy as text (one or more policies, as a header or `<meta>` carries them), so that the library drops the `origins.connect` and `fetchBridge.allow` entries it refuses, on every engine; `false` when your page sends none. Left out, every `origins.connect` and `fetchBridge.allow` entry is dropped, with one warning: the library never asks the page for its policy. A browser without Trusted Types (Firefox) applies your page's `require-trusted-types-for` and `trusted-types` only from the text you pass ([Trusted Types without the browser](#trusted-types-without-the-browser)). See [Host page policy](#host-page-policy)." },
    entry: { type: "`string`",
        what: "The path of a registered JavaScript file the worker runs first. Ignored with a warning in other modes. If it is not a registered JavaScript file the sandbox terminates (`the guest entry \"…\" is not a registered JavaScript file`)." },
    watchdogTimeout: { type: "`number` (ms)",
        what: "Terminates a guest that stops answering for this long (`the guest stopped responding (watchdog)`). Anything but a finite number `> 0` is off, with a warning unless it is `0`. Bounds a looping guest in strict, sealed and worker mode on every browser, and in cooperative mode only where the browser runs the frame in its own process. Starts at `ready`, so it covers the guest's startup scripts too. Needs the guest bootstrap to run. [ADR-003](ADR-003-lifecycle-and-liveness.md)" },
    workerExecutionTimeout: { type: "`number` (ms)",
        what: "A deadline for each `execute()`, this long after the element posts the code, at which the guest's event loop must be free: the element pings the guest, and if no answer arrives within `EXECUTION_TIMEOUT_GRACE_MS` the sandbox ends: a `sandbox-log` line `Execution Timeout` (`source: 'host'`), then `terminated` with `the executed code ran longer than workerExecutionTimeout`. See [`execute()`](#executecode). Anything but a finite number `> 0` is off, with a warning unless it is `0`." },
    autoResize: { type: "`boolean`",
        what: "Only a literal `true` enables it. The element's height follows the guest's content height, from `ready` on (the guest document may still be loading then); see [Limits](#limits) for the bounds. In worker mode it does nothing, with one warning. Without it, the height is left to your CSS." },
    fetchBridge: { type: "`FetchBridgeConfig`",
        what: "Opens [`sandboxFetch()`](#sandboxfetch); the host decides each request, and a hidden frame with an opaque origin makes it (the target sees `Origin: null`). A config without it turns the bridge off (`sandboxFetch()` rejects with `FETCH_NOT_ALLOWED`). Not in sealed mode: a sealed config that names it is refused. [ADR-006](ADR-006-fetch-bridge.md)" },
    callLimits: { type: "`CallLimits`",
        what: "The per-second budget of the calls the guest makes, per environment; see [below](#calllimits)." },
    allowAnimations: { type: "`boolean`",
        what: "Whether CSS animations and transitions run in the view. **While `true`, they run on your page's main thread wherever the browser runs the view there (Firefox, Safari and WebKit, Android, Chromium without sandboxed-iframe isolation), and the view's time budget does not bound them: a guest can keep your page 80–98% busy.** `false` removes them (elements show their end state). Only a literal `true` keeps them: left out or `false` removes them, and so does any other value, with one warning when it is not a boolean. Ignored with a warning in other modes. See [below](#allowanimations-and-allowautoplay)." },
    allowAutoplay: { type: "`boolean`",
        what: "Whether `<video autoplay>` and `<audio autoplay>` in the view start on their own; while `false` the `autoplay` attribute is removed and media plays only when the user starts it. With `true`, playing media costs your page's main thread where the view shares it (measured up to +6 points for 20 looping videos), outside the time budget. Only a literal `true` enables it: left out or `false` keeps it off, and so does any other value, with one warning when it is not a boolean. Ignored with a warning in other modes. See [below](#allowanimations-and-allowautoplay)." },
    guestWrites: { type: "`boolean`",
        what: "Only a literal `true` enables it. The guest's [`sandboxFiles.write()` and `remove()`](#sandboxfiles) are recorded by the element as pending changes of this environment; they reach the files only through [`commitGuestWrites()`](#commitguestwritespaths-options). See [Guest writes](#guest-writes)." },
};
