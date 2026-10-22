# Threat model

What `web-sandbox` defends, against whom, by which mechanism, and what it leaves to the embedder and the browser. This
page states the current model only. Each property names the code that enforces it (its chokepoint) and the test that
keeps it closed; where a reader wants the evidence, a stable ID ([ids.ts](ids.ts): `ADR-005#…`, `R5:M-2`, `S73`) or
a research folder leads to it. The surface is [API.md](API.md), the map is [ARCHITECTURE.md](../ARCHITECTURE.md), and
the reasons are the [ADRs](README.md#decisions).

- [Assets and parties](#assets-and-parties)
- [Trust boundaries](#trust-boundaries)
- [Security properties](#security-properties)
- [Availability](#availability)
- [Out of scope, and what the embedder must do](#out-of-scope-and-what-the-embedder-must-do)
- [Accepted risks and open items](#accepted-risks-and-open-items)
- [Reporting and fixing a finding](#reporting-and-fixing-a-finding)

## Assets and parties

| Party | Trusted | What it holds or can do |
| :--- | :--- | :--- |
| The embedder: the host page, its origin, its scripts | yes | Owns the element, its configuration, the methods it `expose()`s, the fetch bridge's allowlist. |
| Guest code and content: `html`, `load()`, registered files, `entry`, `execute()` code | **no**: the adversary | Anything a script can do in the realm it is given, and any markup or CSS the view will render. |
| The library's own code in the sandbox: the wrapper and the strict view (no guest code), worker mode's frame, and the bootstrap, prelude and broker that share a realm with guest code | yes, but see [boundary 4](#trust-boundaries) | The guest's end of every port, the budgets counted in the guest realm. |
| The user | yes | Gestures in the view; the browser's own actions on what it shows (open in a new tab, drag, copy). |
| The network: the origins the embedder lists (`origins`, `fetchBridge.allow`) | as far as the embedder trusts them | Receives what the guest sends them; the policy admits them. |
| Every other origin, other sandboxes on the page, other tabs | no | Must not be reachable from the guest, nor reach it. |
| The browser | yes | Enforces the opaque origin, the sandbox flags and the policy; its bugs are out of scope, its documented differences are not ([below](#engine-differences-that-change-a-guarantee)). |

**Assets.** The host page's DOM, scripts and storage; its cookies and the user's session; its URL (path, query,
fragment) and, as far as engines allow, its origin; the host page's thread (availability); the embedder's exposed
methods and whatever data it hands the guest (which must leave only to listed origins); other sandboxes' state.

**What the library promises the embedder, per mode.** Strict mode is the default and is for content you do not trust;
cooperative mode is for content that cooperates, with a frozen list of limits ([S44](BACKLOG.md#s44)); worker mode is
frozen ([S49](BACKLOG.md#s49)).

| Promise | `strict` (default) | `cooperative` | `worker` |
| :--- | :--- | :--- | :--- |
| Guest code cannot read or change the host page's DOM, scripts, storage, Service Workers or `document.cookie` | ✓ | ✓ | ✓ |
| No guest script runs in any document | ✓ | — (by design) | ✓ (the frame runs only the library's bootstrap) |
| Guest code cannot navigate the host page, the tab or its own frame | ✓ | ✓, except the user's modifier clicks and the guest's synthesized ones on a link ([R1:R2-2](archive/reviews/REVIEW-ROUND-1-2026-10-15.md#r1-r2-2)) and session-history entries | ✓ |
| The guest reaches the network only through the policy (`origins`) or the fetch bridge | ✓ | ✓, except frames and workers the guest creates, WebKit's preconnect and the pre-policy window ([S8](BACKLOG.md#s8)) | ✓ |
| Nothing the guest reads reveals the host page's URL | ✓ | partly: [S15](archive/backlog/BACKLOG-done.md#s15), [S17](archive/backlog/BACKLOG-done.md#s17), [S18](archive/backlog/BACKLOG-done.md#s18) | ✓ |
| The host can always stop the guest | ✓, but `terminate()` waits for a stall of the view where it shares the host page's thread, and for reports already queued ([Availability](#availability); [S77](BACKLOG.md#s77), [S78](BACKLOG.md#s78)) | only where the frame has its own process | ✓, but it waits for reports already queued ([S77](BACKLOG.md#s77), [S78](BACKLOG.md#s78)) |
| The host page's availability | a stated bound where the view shares its thread ([Availability](#availability)) | none where the frame shares its thread | the worker is off the thread; Firefox's rejection reports are bounded |
| `violation` reports cannot be forged | the view's (`source: 'view'`) | no | no |

## Trust boundaries

<!-- describes: realms, channels sig:acafb441 -->

The realms and the channels between them are generated from the code in [ARCHITECTURE.md](../ARCHITECTURE.md#modes-and-realms)
(which realm runs guest code, which library functions are stringified into it) and
[Channels and frames](../ARCHITECTURE.md#channels-and-frames) (every frame type, its route, and what bounds each field).
The boundaries those tables cross:

1. **The host page and the sandbox.** Every frame of the sandbox is a sandboxed `srcdoc` frame that never gets
   `allow-same-origin`, `allow-top-navigation*` or `allow-popups-to-escape-sandbox`, so each document in it has an
   opaque origin of its own (a worker has its document's), cross-origin to the host page and to every other sandbox. What crosses is the
   library's ports, the one announcement (cooperative and worker mode) or `INIT_VIEW` (strict mode), `BRIDGE_INIT` to the
   fetch bridge's frame (with `fetchBridge`, which the guest has no handle on), and, in cooperative mode only, whatever
   the guest posts to the host window, and a bootstrap's portless refusal when its document is not the one the library
   built (`ENVIRONMENT_REFUSED`, which ends the sandbox).
2. **The wrapper and what it holds.** The element's frame holds a wrapper document of the library's: policy
   `frame-src 'none'`, base `about:blank`, `no-referrer`, no script. The guest frame or the strict view inside it cannot
   navigate itself anywhere ([research 14](research/14_self_navigation/README.md)).
3. **The view and the strict worker.** The view runs one script, the library's, admitted by its hash; guest logic runs
   only in the worker. Markup crosses this boundary on the render port and is cleaned by an allowlist renderer before it
   enters the view's document ([ADR-005](ADR-005-strict-mode.md)).
4. **Library code and guest code in one realm.** The bootstrap (cooperative and worker mode), the strict prelude and the
   broker run in the guest's realm, first. Their guarantees hold because they capture every platform function they use
   before guest code runs, and because the worker keeps only allowlisted globals. This is the weakest boundary: what the
   host can count again (log lines, calls, frame sizes) it counts again on receipt; what it cannot see (the worker's
   uncaught errors and rejections) rests on that code running first ([S69](BACKLOG.md#s69) would move it to a realm of
   the library's).
5. **The sandbox and the network.** One policy template per mode, filled with exact origins only
   ([ADR-007](ADR-007-typed-origins.md)); the fetch bridge's rules run on the host, and its requests are made by a frame
   of the library's with an opaque origin, never by the host page ([ADR-006](ADR-006-fetch-bridge.md)).
6. **The fetch bridge and the host page's fetch environment.** The host page's Service Worker, its `fetch` wrappers and
   its origin's authority never apply to a bridge request: the request is made in the bridge's frame, an opaque origin
   no Service Worker controls and no host script reaches ([BD1:ISO-1](#bridge-frame)).

Every sandbox realm's origin is opaque, and serializes as `"null"`, so no message check reads an origin string: the host takes
the announcement only from the guest frame's own window (`event.source`), the view takes `INIT_VIEW` only from
`parent.parent`, and everything after that travels on ports only the library's code holds. The host posts `INIT_VIEW`
with the target origin `'*'`, because an opaque origin cannot be named; the target is the window the wrapper holds at
its one load, the view, and in strict mode no guest code exists anywhere before `INIT_VIEW` carries the worker's
source.

## Security properties

Each table gives the property, the mechanism, the chokepoint in code, the test that enforces it and the evidence.
Specs under `test/e2e/` and `docs/research/` run on Chromium, Firefox and WebKit.

### Isolation of the guest from the host

<!-- describes: capabilities sig:5a25 -->

| Property | Mechanism | Chokepoint | Enforced by | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| No access to the host page's DOM, scripts, storage, cookies (`document.cookie`) or Service Workers | Sandboxed frames without `allow-same-origin`: an opaque origin. The flags come only from closed lists; `allow-same-origin` and top navigation are on neither | `SAFE_CAPABILITIES`, `UNSAFE_SANDBOX_FLAGS` (`src/csp-directives.ts`); `filterCapabilities` (`src/lib/capabilities.ts`); `_getSandboxFlags` (`src/host.ts`) | `test/unit/host.test.ts` (the closed lists: no dangerous capability on them); `test/e2e/security.spec.ts` ("Isolation": the opaque origin the flags give); `test/e2e/capability-presets.spec.ts` (the `sandbox` attribute the frame gets, and the flags dropped with a warning); research [02](research/02_sw_tampering/README.md), [03](research/03_storage_sharing/README.md), [05](research/05_outer_frame_tampering/README.md) reproductions | [ADR-001](ADR-001-continue-or-adopt.md#the-opaque-origin-and-the-unique-origin) |
| No navigation of the guest's own frame, the host page or the tab | The wrapper's `frame-src 'none'`; no `allow-top-navigation*`; `form-action 'none'`, `base-uri 'none'`; strict: every rendered link's href is `INERT_HREF`, link clicks and submits are cancelled, `meta`, `base` and frames are never rendered | `WRAPPER_CSP`, `buildWrapperDocument` (`src/lib/frame-documents.ts`); `INERT_HREF`, `RENDER_ELEMENTS` (`src/lib/in-sandbox-view.ts`) | research [14](research/14_self_navigation/README.md) and [07](research/07_data_uri_navigation/README.md) reproductions; `test/e2e/strict.spec.ts` ("G4 navigation"); `test/e2e/worker-globals-and-termination.spec.ts` ("V3") | `ADR-005#the-guarantees-on-chromium-firefox-and-webkit` (G4) |
| No popups unless the embedder opts in | `allow-popups` is an unsafe capability (cooperative and worker mode only, with a warning); strict mode takes none | `UNSAFE_SANDBOX_FLAGS`; `CONFIG_SCHEMA.unsafeCapabilities` (`src/lib/config-schema.ts`) | research [13](research/13_popup_exfiltration/README.md) reproduction; `test/e2e/hard-security.spec.ts` | [research 13](research/13_popup_exfiltration/README.md) |
| No pointer lock unless the embedder opts in | `allow-pointer-lock` is an unsafe capability like `fullscreen` (cooperative and worker mode only, with a warning; dropped from `capabilities`, and from `unsafeCapabilities` in strict mode): a guest holding the lock can hide the cursor and capture relative input, so it can draw a cursor of its own over fake host UI | `UNSAFE_SANDBOX_FLAGS`; `CONFIG_SCHEMA.capabilities`, `CONFIG_SCHEMA.unsafeCapabilities` (`src/lib/config-schema.ts`) | `test/unit/config-schema.test.ts`; `test/e2e/pointer-lock.spec.ts` | the UI-spoofing reasoning of `fullscreen` ([README](../README.md#capabilities)) |
| The host page's URL is not readable | The wrapper's base is `about:blank` and both frames are `no-referrer`; strict: the renderer forces `referrerpolicy="no-referrer"`, and the worker's location is its own `blob:` URL | `WRAPPER_BASE`, `FRAME_REFERRER_POLICY` (`src/lib/frame-documents.ts`); `sanitizeRender` | `test/e2e/host-url.spec.ts` | [S15](archive/backlog/BACKLOG-done.md#s15); cooperative residuals [S17](archive/backlog/BACKLOG-done.md#s17), [S18](archive/backlog/BACKLOG-done.md#s18) |
| A library bootstrap runs only in the document the library built | The first statement of each bootstrap (the hashed view and bridge bootstrap, the cooperative guest's, worker mode's frame's) checks the document's origin (`self.origin` is `'null'`), URL (`about:srcdoc`) and base URL (`about:blank`). On a difference it registers and runs nothing, posts a portless `ENVIRONMENT_REFUSED`, stops the cooperative guest's parser, and the element ends the sandbox with the reason of that row (taken from its own table, never from the message). A host page whose `base-uri` refuses the wrapper's `<base>` is caught this way (the guest would otherwise read the host page's URL), and so is a copy of a bootstrap run anywhere else | `ENVIRONMENT_CHECKS`, `checkSandboxEnvironment` (`src/lib/environment-check.ts`); `environmentGate` (`src/lib/in-sandbox-view.ts`); `_listenForAnnouncement` (`src/host.ts`) | `test/unit/environment-gate.test.ts` (the check is each bootstrap's first and only statement; each row leaves each bootstrap inert); `test/unit/environment-check.test.ts`; `test/e2e/environment-check.spec.ts` (`base-uri` in every mode; copies outside a sandbox document) | [S74](BACKLOG.md#s74) |
| Strict: no guest script runs in any document | The view's `script-src` is the bootstrap's hash with `script-src-attr 'none'`; an allowlist renderer drops scripts, handlers, frames, `meta`, `base`, templates; markup is moved, never cloned | `strictViewPolicy` (`src/lib/csp/csp-generator.ts`); `sanitizeRender`, `RENDER_ELEMENTS`, `RENDER_ATTRIBUTES` | `test/e2e/strict.spec.ts` ("G1"); `test/e2e/strict-renderer.spec.ts`; `src/lib/in-sandbox-view.test.ts` | `ADR-005#the-renderer`; [research 15](research/15_strict_mode/README.md) |
| Strict: nothing the view shows opens as a script-running document | The view mints URLs only for `VIEW_FILE_TYPES`; `data:` is not an origin, so no image, font or media loads from it | `VIEW_FILE_TYPES` (`src/lib/in-sandbox-view.ts`); `src/lib/load-kinds.ts` | `test/e2e/strict-renderer.spec.ts` ("ST1"); `test/unit/strict.test.ts` | [BR:ST1](archive/reviews/BROAD-REVIEW-2026-10-14.md#br-st1) |
| One sandbox's files reach neither the host page nor another sandbox | Files are `blob:` URLs minted in the guest's own realm, which resolve nowhere else | `inSandboxFiles` (`src/lib/in-sandbox-files.ts`) | `test/e2e/files.spec.ts`; `test/e2e/blob-delivery.spec.ts` | [ADR-004](ADR-004-files-as-blob-urls.md) |

### Egress

<!-- describes: origins, csp:strict, csp:cooperative, worker-globals sig:d262c7425d10389e -->

| Property | Mechanism | Chokepoint | Enforced by | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| The policy is fixed per mode; the embedder adds exact origins and nothing else | One origin parser at the boundary; one template per mode, every directive explicit, so nothing falls back; `frame-src`, `object-src`, `base-uri`, `form-action`, `manifest-src` are `'none'`, `worker-src` is `blob:`; `'unsafe-eval'` only from `scriptUnsafe` | `parseOrigin` (`src/lib/origin.ts`); `parseOrigins` (`src/lib/csp/origins.ts`); `cooperativePolicy`, `strictViewPolicy` (`src/lib/csp/csp-generator.ts`) | `src/lib/csp/csp-generator.test.ts`; `src/lib/origin.test.ts`; `test/unit/policy-guarantees.test.ts`; `test/unit/fetch-and-csp-guarantees.test.ts` | [ADR-007](ADR-007-typed-origins.md), [S47](archive/backlog/BACKLOG-done.md#s47) |
| The policy is in force before any guest content | The policy `<meta>` is the first element of the guest document; strict mode's view holds no guest markup when it is parsed | `buildGuestDocument` (`src/lib/frame-documents.ts`) | [research 11](research/11_meta_csp_delivery/README.md) reproduction | cooperative residual [S8](BACKLOG.md#s8) |
| The guest's worker requests only through APIs the policy governs on every engine | The worker keeps only the globals of an allowlist, deleted before guest code: `fetch`, `XMLHttpRequest`, `WebSocket` (`connect-src`) and `importScripts` (`script-src`) request; `EventSource`, `FontFace`, `WebTransport`, nested workers and the worker's own `postMessage` are absent | `WORKER_GLOBALS`, `keepOnlyWorkerGlobals` (`src/lib/worker-globals.ts`) | `src/lib/worker-globals.test.ts`; `test/e2e/worker-globals-and-termination.spec.ts` ("V1") | [VR:V1](archive/reviews/VERIFICATION-2026-10-14.md#vr-v1), `ADR-005#the-workers-globals-are-an-allowlist` |
| No WebRTC | Strict and worker mode: absent from the worker, and the view renders no frame; cooperative mode: removed from the guest's realm before guest code (a frame the guest creates keeps it: a limit) | `WORKER_GLOBALS`; `inSandboxScript` (`src/lib/in-sandbox-script.ts`) | `test/e2e/webrtc.spec.ts` | [S13](archive/backlog/BACKLOG-done.md#s13) |
| The view loads only what the policy admits, at a bounded rate | The renderer keeps a URL only where every engine's policy check admits it, and drops the rest before the browser sees it; every load is charged before it can start (CSS-borne ones counted from the text); `VIEW_URLS_PER_SECOND`, `VIEW_MAX_URLS`, `VIEW_MAX_DISTINCT_URLS` | `sanitizeRender`, `cssLoadBound`, `viewBudget` (`src/lib/in-sandbox-view.ts`) | `test/unit/view-css-loads.test.ts`; `test/e2e/strict-view-budget.spec.ts`; `test/e2e/worker-port-and-view-cost.spec.ts` | [S73](archive/backlog/BACKLOG-done.md#s73), [R5:M-3](archive/reviews/REVIEW-ROUND-5-2026-10-19.md#r5-m-3) |
| The fetch bridge sends only what the embedder allows | On the host: exact-origin allowlist, the host origin and private hosts refused unless listed, `credentials: 'omit'`, `no-referrer`, redirects never followed, method and header allowlists (`Cookie` never), capped bodies, time and concurrency; the platform's `Request` validates first; every request ends with its environment and is logged as a `fetch` event | `createFetchBridge`, `validateRequest`, `isPrivateHost` (`src/lib/fetch-bridge.ts`) | `src/lib/fetch-bridge.test.ts`; `test/unit/fetch-bridge-lifecycle.test.ts`; `test/e2e/fetch-bridge.spec.ts` | [ADR-006](ADR-006-fetch-bridge.md) |
| <a id="bridge-frame"></a>A bridge request runs in no fetch environment of the host page's: no Service Worker of its answers it, no `fetch` wrapper of its applies, and the target sees `Origin: null` | The bridge's one transport is a hidden frame of the library's (`sandbox="allow-scripts"`, an opaque origin; its own policy: the library's bootstrap by hash, `connect-src` the allowlist only), which makes every request with the pinned options; the host never calls its page's `fetch`; a frame that never starts fails the bridge closed | `createBridgeFrame`, `prepareBridgeFrame` (`src/lib/bridge-frame.ts`); `inBridgeFrame` (`src/lib/in-bridge-frame.ts`); `buildBridgeDocument` (`src/lib/frame-documents.ts`); `bridgeFramePolicy` (`src/lib/csp/csp-generator.ts`) | `test/unit/structural.test.ts` (no `fetch` outside the two realm functions; the one transport); `test/unit/bridge-frame.test.ts`; `test/e2e/fetch-bridge-isolation.spec.ts` (a cache-first Service Worker, an auth wrapper, `Origin: null`, teardown, the host page's policy) | [ADR-006](ADR-006-fetch-bridge.md) |
| Cooperative mode: the gaps no directive covers, closed in the guest's realm | `fetch` with `keepalive` refused, history traversal inert, `window.name` inert, DNS prefetch off; a frozen list: a new gap is a limit, not a patch | `inSandboxScript`; `buildGuestDocument` | `test/unit/guest-realm-hardening.test.ts`; `test/e2e/guest-realm-hardening.spec.ts` | [BR:PD2](archive/reviews/BROAD-REVIEW-2026-10-14.md#br-pd2), [S44](BACKLOG.md#s44) |

`registerProtocolHandler` and a top-level navigation to a `data:` URL are refused by the browser in a sandboxed frame
(research [06](research/06_protocol_handlers/README.md) and [07](research/07_data_uri_navigation/README.md), each with
its reproduction); a worker has neither. Direct `WebSocket` and `fetch` connections to an origin in `origins.connect`
are governed by the policy but not logged: only the bridge's requests are `fetch` events
([research 04](research/04_websocket_bypass/README.md)).

### Channel integrity

<!-- describes: frames sig:e118 -->

| Property | Mechanism | Chokepoint | Enforced by | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| One announcement per environment, by window identity | A host listener, installed before the frame, takes one trusted message from the guest frame's own window carrying exactly one port and stops it there; a second announcement, or a forged one, ends that environment | `_listenForAnnouncement` (`src/host.ts`); the reducer's `announced` input (`src/lib/lifecycle.ts`) | `test/e2e/guest-realm-hardening.spec.ts` (PD8); `test/e2e/worker-globals-and-termination.spec.ts` ("L2"); `test/e2e/ready.spec.ts` | [BR:CB1](archive/reviews/BROAD-REVIEW-2026-10-14.md#br-cb1), `ADR-002#the-channel` |
| The guest's end of a port never reaches guest code | The bootstrap makes the channel itself and keeps its end in a closure; every port and event operation uses primitives captured before guest code, through a captured `Reflect.apply`; a source scan forbids lookups after the capture point | `CAPTURE_POINT` in `src/lib/in-sandbox-script.ts`, `src/lib/rpc.ts`, `src/lib/in-sandbox-view.ts` | `test/unit/bootstrap-capture-and-measure.test.ts`; `test/e2e/channel-isolation.spec.ts` ("B2") | [R2:C-1](archive/reviews/REVIEW-ROUND-2-2026-10-15.md#r2-c-1) |
| Strict mode's ports reach only the library's code | The view takes one `INIT_VIEW` from `parent.parent`; the worker's prelude takes one trusted `INIT_WORKER` (a guest's synthetic event is not trusted) and keeps the render port in a closure | `inSandboxView`, `inStrictWorker` (`src/lib/in-sandbox-view.ts`) | `test/e2e/strict-entry-scope-and-links.spec.ts`; `test/e2e/strict.spec.ts` | `ADR-005#flow-control-files-clobbering-liveness` |
| Only the current environment is heard, and answered | The host handles a frame only from the current port; an answer goes back on the port its request came from, which teardown closed | `_onGuestMessage`, `_onViewMessage` (`src/host.ts`) | `test/unit/channel-guarantees.test.ts` ("B4"); `test/e2e/channel-isolation.spec.ts` | [AR:B4](archive/reviews/ADVERSARIAL-REVIEW-2026-10.md#ar-b4) |
| A call reaches only what the other side exposed, and a refusal code cannot be forged | Dispatch through a `Map` of exposed names; `sandbox:` names in a registry of their own; a code reported by the other side is clamped to its group, and a library code passes only for a reserved method on the guest's broker | `createBroker` (`src/lib/rpc.ts`) | `src/lib/rpc.test.ts`; `test/e2e/broker.spec.ts` | `ADR-002#refusal-codes`, `ADR-002#reserved-methods-and-library-codes` |
| The fetch bridge's port reaches only the library's code | The bridge's frame takes one `BRIDGE_INIT` from its parent (the host page) with one port; the host hears only that frame's port while it is open, and nothing of the guest's is on it | `inBridgeFrame` (`src/lib/in-bridge-frame.ts`); `createBridgeFrame` (`src/lib/bridge-frame.ts`) | `test/unit/bridge-frame.test.ts`; `test/e2e/fetch-bridge-isolation.spec.ts` | [ADR-006](ADR-006-fetch-bridge.md) |
| Every frame is declared and bounded before it is posted (the measure's gap: [S77](BACKLOG.md#s77)) | One frame table; RPC frames built only by the broker's three builders; every string a frame carries out of a guest realm, the view or the bridge's frame is cut, checked or measured before posting, and checked again by the host | `FRAMES` (`src/lib/frames.ts`); `requestFrame`, `resultFrame`, `refusalFrame` (`src/lib/rpc.ts`); `createSizeOf` (`src/lib/structured-size.ts`) | `test/unit/structural.test.ts`; `test/unit/rpc-bounds-and-call-limits.test.ts` | [R3:C-1](archive/reviews/REVIEW-ROUND-3-2026-10-18.md#r3-c-1), [R2:C-3](archive/reviews/REVIEW-ROUND-2-2026-10-15.md#r2-c-3) |
| A guest value is read once, at the boundary | Library code in a guest realm reads each property of a guest value once, as a snapshot | the stringified functions of `src/lib/realms.ts` | `test/unit/read-once.test.ts` | [R5:N-6](archive/reviews/REVIEW-ROUND-5-2026-10-19.md#r5-n-6) |
| The view's violation reports are complete and unforgeable | No guest code runs in the view, and the host labels each report by the port it arrived on; capped per directive | `_dispatchViolation` (`src/host.ts`) | `test/e2e/violations.spec.ts` | `ADR-005#the-guarantees-on-chromium-firefox-and-webkit` (G6) |

Reports from the worker (`source: 'logic'`) and from cooperative mode come from the guest's realm: guest code can
forge or suppress them, and they differ per engine. Treat them as claims.

### Lifecycle integrity

<!-- describes: lifecycle:states, lifecycle:inputs sig:204e6fd0 -->

| Property | Mechanism | Chokepoint | Enforced by | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| An old environment cannot act | Every callback, timer and port input carries the generation it was armed in, and `reduce` drops a stale one with no effect | `reduce`, `isStale` (`src/lib/lifecycle.ts`) | `test/unit/lifecycle-reducer.test.ts`; `test/unit/lifecycle-model.test.ts`; `test/e2e/lifecycle-model.spec.ts` | `ADR-003#the-lifecycle-is-one-reducer`, [S65](archive/backlog/BACKLOG-done.md#s65) |
| Queued work leaves only at `ready`, and `ready` follows the guest's check-in (a cooperative frame without `allow-scripts` has no guest code: `ready` follows the frame's load, and no guest script has run) | Only `loading` reaches `ready`, on the announcement or the view's `VIEW_READY` (or, with no guest script allowed, the wrapper's load); the `flush` effect is emitted only by that transition | `LC_INPUTS`, `reduce` (`src/lib/lifecycle.ts`) | `test/unit/lifecycle-transitions.test.ts`; `test/unit/call-settling-and-read-once.test.ts` | [R5:L-1](archive/reviews/REVIEW-ROUND-5-2026-10-19.md#r5-l-1) |
| `terminate()` or removing the element ends everything of the environment | Teardown removes the frame (the workers end with the document that made them), closes the ports, rejects pending calls with `TERMINATED`, aborts the bridge's requests and closes the guest-write overlay. It detaches, then releases: every per-environment field is written first (the declared list, `ENVIRONMENT_RELEASES`), and only then is anything released, from the record. A release can run embedder code synchronously (a frame's removal fires the host window's `focus` on Firefox; a focused guest's `pagehide` can call `parent.parent.focus()` on every engine), and a `reset()`, `load()` or `setConfig()` there builds a new environment whose fields the outer teardown never writes again. A frame already detached is not an error | `_teardown` (`src/host.ts`); `ENVIRONMENT_RELEASES`, `detachEnvironment`, `releaseEnvironment` (`src/lib/environment.ts`); `abortAll` (`src/lib/fetch-bridge.ts`) | `test/unit/teardown-reentry.test.ts` (re-entry at every declared release point and every `remove()` and `close()` the teardown makes; a scan that `_teardown` writes no field after its first release); `test/e2e/teardown-reentry.spec.ts`; `test/e2e/worker-globals-and-termination.spec.ts` ("L1"); `test/unit/fetch-bridge-lifecycle.test.ts` | [LM-1](research/17_formal_methods/lifecycle-model.md#lm-1), [LM-2](research/17_formal_methods/lifecycle-model.md#lm-2), [S74](BACKLOG.md#s74) |
| Embedder code that runs inside the element's own calls cannot corrupt it | A build is prepared detached and attached only if still current; events are dispatched after the state is stored, with deeply frozen details | the `build` and `attach` effects (`src/lib/lifecycle.ts`); `src/lib/element-events.ts` | `test/unit/lifecycle-reentry.test.ts`; `test/unit/lifecycle-edge-cases.test.ts`; `test/unit/element-events.test.ts` | [LM-2](research/17_formal_methods/lifecycle-model.md#lm-2), [R4:L-1](archive/reviews/REVIEW-ROUND-4-2026-10-18.md#r4-l-1) |
| A guest that reloads or rewrites its document is ended | The wrapper loads once and the guest announces once; a second of either ends the environment, and no port is handed to the new document | the reducer's `frameLoad` and `announced` inputs | [research 14](research/14_self_navigation/README.md) reproduction ("14.2"); `test/e2e/ready.spec.ts` | [research 14](research/14_self_navigation/README.md) |
| Nothing builds in another window's document | One predicate, asked by every build | `buildsHere` (`src/host.ts`) | `test/unit/lifecycle-edge-cases.test.ts`; `test/e2e/foreign-document-and-view-time.spec.ts` | [R2:L-1](archive/reviews/REVIEW-ROUND-2-2026-10-15.md#r2-l-1) |
| A guest that never checks in does not stay `loading` | The load deadline, `LOAD_TIMEOUT_MS` of host time | the `startLoadDeadline` effect | `test/e2e/ready.spec.ts` | `ADR-003#ready-is-the-guests-check-in` |

### Resource limits

<!-- describes: budgets:channels sig:8864 -->

| Property | Mechanism | Chokepoint | Enforced by | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| Strict and worker mode: a looping guest never holds the host page's thread, and the host can stop it | Guest code runs in a worker; `terminate()` ends the environment, but cannot run during a stall of the view on the host page's thread, nor before the reports already queued are processed ([S77](BACKLOG.md#s77), [S78](BACKLOG.md#s78)); `watchdogTimeout` (opt-in) ends a guest that stops answering, and `workerExecutionTimeout` one whose `execute()` overruns its deadline; the bootstrap answers the probes, and guest code cannot answer for it | `startWatchdog` (`src/lib/watchdog.ts`); `_startWatchdog` (`src/host.ts`) | `src/lib/watchdog.test.ts`; `test/e2e/watchdog.spec.ts`; `test/e2e/worker-timeout.spec.ts` | `ADR-003#strict-mode-bounds-execution-on-every-engine`, [S6](archive/backlog/BACKLOG-done.md#s6) |
| Strict: a view that stops answering ends the sandbox | The host pings the view always, `VIEW_LIVENESS_TIMEOUT_MS`, host stalls not counted. Where the view has a process apart from the host page's (desktop Chromium), one long operation is no host stall, so a documented stall over about 5 s ends a healthy sandbox; the process is shared by the page's sandboxed frames, so another sandbox's loop or stall does the same ([S79](BACKLOG.md#s79)) | the view watchdog (`src/host.ts`) | `test/e2e/strict.spec.ts` ("A5") | `ADR-005#flow-control-files-clobbering-liveness` |
| Every channel of guest activity is bounded in count, bytes and time, except the gaps listed below the table ([S77](BACKLOG.md#s77), [S78](BACKLOG.md#s78)) | One table of surfaces (the egress table) and one of channels (`CHANNEL_BUDGETS`), each naming its constants; the bootstrap installs exactly the listeners of its rows; logs and calls are counted by the guest and again by the host | `EGRESS`, `CHANNEL_BUDGETS`, `bootstrapListeners` (`src/lib/egress.ts`) | `test/unit/budgets.test.ts`; `test/unit/egress.test.ts`; `test/e2e/egress.spec.ts` (every engine's surfaces against the table) | [API.md, Budgets](API.md#budgets); [R5:N-1](archive/reviews/REVIEW-ROUND-5-2026-10-19.md#r5-n-1) |
| Strict: the view's cost to the thread it runs on is one stated bound | A long-run share (`VIEW_APPLY_MS_PER_SECOND`), the single-operation bound with the repeated-overrun rule, rates and caps on what the meter cannot see, and a closed list of what is outside | `viewBudget` (`src/lib/in-sandbox-view.ts`) | `test/e2e/view-bound.spec.ts`; `test/unit/view-bound.test.ts`; `test/unit/view-budget.prop.test.ts` | [API.md, The view's cost to the host page](API.md#the-views-cost-to-the-host-page); [S72](archive/backlog/BACKLOG-done.md#s72), [R5:M-2](archive/reviews/REVIEW-ROUND-5-2026-10-19.md#r5-m-2) |
| A config cannot make a budget fail open | One schema decides every option and its cross-field invariants before anything is built; `callLimits` has no off switch (it takes finite numbers ≥ 1), and every call that can be carried fits an empty window | `CONFIG_SCHEMA`, `normaliseConfig` (`src/lib/config-schema.ts`) | `test/unit/config-schema.test.ts`; `test/unit/rate-limit.prop.test.ts` | [R5:L-2](archive/reviews/REVIEW-ROUND-5-2026-10-19.md#r5-l-2) |

**Open gaps in these rows** (owner, 2026-10-21: backlogged, not mitigated now; they stay rated high).
- **The byte measure counts a proxy** ([S77](BACKLOG.md#s77)). A `Blob` or a `File` measures 64 bytes though a clone
  carries the `File`'s `name` (and the `Blob`'s `type` on Firefox and WebKit) whole, and a sparse array measures its
  present elements, not its `length`. So a guest can pass the byte budgets of log lines, calls, results and the bytes of
  calls running at once with a long `File` name (on Chromium, 8 calls held 1 GiB against the 64 MiB cap), stall
  Firefox's host page deserializing it, and hold the host page's thread for a minute or more with one 16-byte log line
  (the library's own `freezeDeep` walks the array's `length`).
- **The uncaught-characters budget** ([S78](BACKLOG.md#s78)): on Firefox a rejection reason whose `Symbol.toStringTag`
  the guest set is not charged its characters, so the host page's thread can stall for seconds a second while the
  sandbox stays `ready` (strict and worker mode).
- **`terminate()` ends such a flood, but only after the reports already queued are processed**: seconds on Firefox,
  on Chromium as long as the queue of sparse-array lines.
- **The view's liveness ping** ends a healthy sandbox on one documented stall on desktop Chromium
  ([S79](BACKLOG.md#s79)); it fails closed.

What holds memory is capped (files, the bridge's about 3 × `maxConcurrent` × `maxBytes`, a bound and not a measurement, the view's document), but no budget counts
memory itself, and the bytes of calls running at once are capped only as far as the measure above is true (not for a
`File`'s name). The values are in [Limits](API.md#limits).

## Availability

**The owner's rule** ([CONTRIBUTING](../CONTRIBUTING.md#availability-findings-owner-2026-10-20)): a finding whose
only effect is that the guest slows the host page is documented, not mitigated further, when the cost is bounded (by
a documented limit, or by the caps on what the view and the guest can hold) and the embedder can end it (`terminate()`,
or removing the element). Such a finding is at most medium, and its fix is the bound, stated in API.md and in the cost
column of its channel in [Budgets](API.md#budgets). Not availability findings, and fixed as any other: a host page that
can never regain control, or a stall bounded by nothing the library states, no cap and no limit, only the browser's
(high); the library's own limits ending a healthy sandbox (a correctness bug); a flood that breaks a security property (a budget that fails open, a check skipped
under pressure, inconsistent state, anything that moves data or crosses the policy).

**The board's rule (owner, 2026-10-21).** In the S74 review board's fix batches, a finding that leaks data is fixed;
every denial-of-service or availability finding, including a budget that fails open with only an availability effect,
is backlogged. Backlogged is not mitigated and not downgraded: [S77](BACKLOG.md#s77) and [S78](BACKLOG.md#s78) are open
and rated high, and the gaps they describe are listed under [Resource limits](#resource-limits).

**Where the view runs.** Firefox, WebKit and Safari, Android WebView and Chromium's headless shell run the strict view on
the host page's thread ([research 16](research/16_view_isolation/README.md)); there no budget of the library's removes
the view's cost, and the bound is what is promised. Desktop Chromium (127 and later) runs it in a process apart from the
host page's, but not in one of its own: the sandboxed frames of the page can share a process, so one sandbox's work (a
cooperative guest's loop, another view's documented stall) can stall another sandbox's view and end it through its
liveness ping ([S79](BACKLOG.md#s79)).

**The residual costs that are documented**, each ended by `terminate()` or by removing the element:

| Cost | Bound | Where it is stated |
| :--- | :--- | :--- |
| The view's operations and loads, where it shares the host page's thread | The long-run share, the single-operation rule, the rates and caps | [API.md (a) to (c)](API.md#the-views-cost-to-the-host-page) |
| What runs without the view acting: CSS animations and transitions while `allowAnimations` is `true` (the default), animated images, indeterminate `<progress>`, autoplaying media, `:hover` restyles, relayout after decodes and font swaps | the caps on what the view holds; `allowAnimations: false` removes animations and transitions | [API.md (d)](API.md#d-outside-the-bound) |
| The documented single-operation stalls (CSS filters, bidirectional text, large selectors, a large textarea's first value): at most medium | Bounded by the caps on the document (what the view can hold); the first stall past `VIEW_MAX_OPERATION_MS` in a `VIEW_OVERRUN_WINDOW_MS` is allowed, the second ends the sandbox, except on desktop Chromium, where the view's liveness ping ends the sandbox at the first stall that lasts over about 5 s ([S79](BACKLOG.md#s79)). Where the view shares the host page's thread, `terminate()` cannot run during one: the embedder regains control when the stall ends | [API.md (b) and (d)](API.md#b-the-single-operation-bound), [(d) Outside the bound](API.md#d-outside-the-bound) |
| Firefox's reports of the worker's unhandled rejections, made on the host page's thread whether cancelled or not | `UNCAUGHT_PER_SECOND` and `UNCAUGHT_CHARACTERS_PER_SECOND`, past which the sandbox ends; one report is made before anything can end it. Not bounded in characters for a reason whose `Symbol.toStringTag` the guest set ([S78](BACKLOG.md#s78), high) | [Budgets](API.md#budgets), `src/lib/egress.ts` |
| Memory | not bounded; the caps bound what is held, not what it costs (and not a `File`'s name, [S77](BACKLOG.md#s77)) | [API.md (d)](API.md#d-outside-the-bound) |

The relay worker that would move the guest's floods off the host page, and make the guest-realm budgets independent of
the prelude's integrity, is designed and deferred ([S69](BACKLOG.md#s69), [research 19](research/19_relay_worker/README.md)).
Cooperative mode is outside the rule: where its frame shares the host page's thread (WebKit always, Chromium in some
environments), one guest loop freezes the host page and no watchdog can stop it. It is for cooperative content.

## Out of scope, and what the embedder must do

**Out of scope.**
- **The browser's own bugs**: the sandbox flags, the opaque origin and CSP are the browser's to enforce. Where an engine
  is known to miss one, the library removes the API instead (the worker allowlist) or states the residual.
- **A compromised host page.** The host page owns the element (its shadow root is open), its ports, its configuration
  and its exposed methods. A script injected into the host page has all of that; protecting the host page is its own
  policy's job.
- **Side channels**: Spectre-class reads, timing (the worker keeps `performance` and timers), and CSS-based probing of the
  view's own content within the policy. Isolation from the host page is by origin; against a Spectre-class reader it
  holds only where the browser runs the sandbox in a process apart from the host page's (desktop Chromium's
  sandboxed-frame isolation, for the view and its worker). That process can be shared with the page's other sandboxed
  frames (other sandboxes' views, guest frames and bridge frames, and the bodies their fetches carry), so it does not
  separate one sandbox from another ([S79](BACKLOG.md#s79)).
- **Browser extensions**, which can read and change any frame.
- **UI spoofing inside the element's box**, and what the user chooses to do with what the view shows.
- **Denial of service by the embedder's own configuration**: an `expose()`d method that does heavy work per call, a
  generous `callLimits` or `fetchBridge`.

**What the embedder must configure or do.**
- **The host page's policy** narrows the sandbox's (a `srcdoc` frame inherits it). It must allow the view bootstrap's
  hash (`viewScriptHash()`) and `worker-src blob:`, or the build ends with a reason that names the host page's policy;
  and the wrapper style (or the frame is 150 px high) and, with `allowAnimations: false`, the animation stylesheet (or
  the view drops the guest's stylesheets), each with a warning ([Host page policy](API.md#host-page-policy)). The fetch
  bridge's frame runs the same bootstrap under the same hash, so a policy that refuses the view refuses it too.
- **Cooperative and worker mode cost the host page its script policy.** Their inline bootstrap needs `'unsafe-inline'` in
  the host page's `script-src`, which a browser ignores next to a hash or a nonce: the page cannot have a nonce- or
  hash-based `script-src` and run these modes; it allows inline script everywhere instead, which removes its own defence
  against an injected `<script>`. Prefer strict mode, whose hash sits beside the page's own.
- **Trusted Types**: a `trusted-types` directive must name the policy `web-sandbox`; `execute()` and the guest's `eval`
  are refused under `require-trusted-types-for 'script'`, and in cooperative mode the guest inherits the requirement.
- **Cross-Origin-Embedder-Policy `require-corp`**: WebKit refuses the view's `blob:` worker, so a strict build fails there.
- **Every string a guest can set is attacker text**: a log line's `args`, a violation's `blockedURI` and `sourceFile`, a
  `fetch` record's `url` (it can be `javascript:`), the message of a call rejected by a guest handler. The library
  validates and clamps its size and shape, not its content. Show it with `textContent`; never pass it to an HTML, URL (a
  link `href`), `eval` or template sink, or the guest's text runs with the host page's authority.
- **Exposed methods are the attack surface** the embedder adds: validate every argument, copy objects with spread, never
  `Object.assign` or `for…in` ([S25](BACKLOG.md#s25)), and throw only errors whose message the guest may see.
- **Opt-ins widen the model**, each with a warning: `scriptUnsafe` (`execute()` and `eval` in the guest's realm;
  `WebAssembly` in the worker), `unsafeCapabilities` (popups, modals, downloads, forms, presentation, pointer lock, fullscreen), `fetchBridge`
  (requests made from an opaque origin: the target sees `Origin: null` and no credentials, so it must not treat `null` as
  trusted, [API.md, `fetchBridge`](API.md#fetchbridge)), `origins` (each listed origin receives whatever the
  guest sends it), `allowAutoplay`.
- **Cooperative mode**: check `event.source` in the host page's own `message` listeners, and do not target named frames
  or windows on a page that embeds sandboxes ([S36](BACKLOG.md#s36), [S44](BACKLOG.md#s44)).
- **A same-site origin** listed in `origins` receives the host site's cookies on the guest's requests in Firefox and
  WebKit (every mode): do not list one. Any `origins` kind that lists the host page's own host, a subdomain or a parent
  of it, or a loopback, private or link-local host, warns once per kind in every mode (`warnHostReach`,
  `src/lib/config-schema.ts`); a sibling subdomain is not recognised (no public-suffix list).

### Engine differences that change a guarantee

| Engine | What differs | Effect |
| :--- | :--- | :--- |
| Firefox, WebKit, Android, Chromium's headless shell | The strict view runs on the host page's thread | Availability is the stated bound, not isolation ([Availability](#availability)) |
| WebKit always, Chromium in some environments | A cooperative frame shares the host page's thread | A cooperative guest loop freezes the host page |
| Firefox | Reports a worker's unhandled rejections on the host page's thread, cancelled or not; lets a worker's `EventSource` and `FontFace` past the policy | The uncaught budget (not for a tagged reason, [S78](BACKLOG.md#s78)); the worker allowlist leaves both out |
| WebKit | Compiles `WebAssembly` without `'unsafe-eval'`; raises no violation reports in workers; refuses the view's `blob:` worker under COEP `require-corp`; sends the full host URL to same-site origins and shows it to frames the guest creates (cooperative) | `WebAssembly` deleted unless `scriptUnsafe`; worker reports are per engine; strict mode does not start under COEP; [S17](archive/backlog/BACKLOG-done.md#s17) and [S18](archive/backlog/BACKLOG-done.md#s18) are cooperative limits |
| Chromium, WebKit | Show the host origin in `location.ancestorOrigins` (cooperative) | A cooperative limit ([S15](archive/backlog/BACKLOG-done.md#s15)) |
| Firefox, WebKit | Attach the host site's cookies to requests to same-site origins | Do not list a same-site origin; `origins` warns for the host page's host, its subdomains and parents, and loopback hosts (not for a sibling subdomain) |
| Firefox (146, as Playwright runs it) | Has no Trusted Types (`typeof trustedTypes` is `undefined`) | The host page's requirement has no effect there; a Firefox that ships them is governed like the other engines |

## Accepted risks and open items

The open items of the [backlog](BACKLOG.md) that bear on this model:

| Item | What | Mode |
| :--- | :--- | :--- |
| [S8](BACKLOG.md#s8) | The pre-policy window of a `<meta>` policy: a request can leave before the policy applies | cooperative |
| [S25](BACKLOG.md#s25) | Guest data can carry an own `__proto__` key; merging it with `Object.assign` sets the target's prototype | every mode |
| [S36](BACKLOG.md#s36) | Focus, the clipboard after a user's click, messages to the host window | cooperative |
| [S44](BACKLOG.md#s44) | Cooperative mode's frozen list of limits, and what strict mode does not cover | cooperative; strict |
| [S69](BACKLOG.md#s69) | The relay worker, deferred: the worker side of class E-cpu stays bounded by guest-realm budgets | strict, worker |
| [S70](BACKLOG.md#s70) | For the owner: with `fetchBridge.maxBytes` above about 16.5 MiB, a long string request body is refused by the guest's broker before the bridge; a tiny `watchdogTimeout` may end a healthy guest | every mode |
| [S49](BACKLOG.md#s49) | Worker mode, frozen until folded into strict mode | worker |
| [S77](BACKLOG.md#s77) | **High**, backlogged (owner, 2026-10-21): the byte measure counts a `File`'s name and a `Blob`'s type as 64 bytes and a sparse array by its present elements; five byte budgets fail open, and the library's own `freezeDeep` walks `length` | strict, worker |
| [S78](BACKLOG.md#s78) | **High**, backlogged (owner, 2026-10-21): a rejection reason tagged with `Symbol.toStringTag` is not charged to the uncaught-characters budget on Firefox | strict, worker |
| [S79](BACKLOG.md#s79) | Medium: on desktop Chromium the view's liveness ping ends a healthy sandbox on one documented stall (fails closed) | strict |
| [S80](BACKLOG.md#s80) | Medium: no test guards the event reads of the bootstrap's `error` and `unhandledrejection` listeners | strict, worker |
| [S81](BACKLOG.md#s81), [S82](BACKLOG.md#s82) | Low: tests that fail under machine load; the other lows of the board's pass 1 | — |
| [S74](BACKLOG.md#s74) | The final adversarial review board of the current state; a pass is clean when none of its findings leaks or can manipulate data (owner, 2026-10-21); passes 1 and 2 (2026-10-21) were not | — |

Residuals stated in the decisions rather than the backlog: DNS rebinding for the fetch bridge
([ADR-006](ADR-006-fetch-bridge.md#consequences)); CSS within the policy, forgeable worker reports, a worker that
closes itself, memory and same-site cookies ([ADR-005](ADR-005-strict-mode.md#consequences)); an image from an allowed
origin opens as that origin's document (`ADR-005#the-renderer`).

## Reporting and fixing a finding

**Reporting.** Report a suspected vulnerability privately, through GitHub's private vulnerability reporting, as
[SECURITY.md](../SECURITY.md) describes; never in a public issue. Include the mode, the engine and its version, and a
reproduction.

**Classifying.** A finding is classified by the invariant it violates, not its symptom, in the classes of
[research 18](research/18_finding_classes/README.md): E-net (egress the policy does not govern), E-cpu (host-thread
work outside the chokepoint), P (a budget that counts a proxy), G (guest-controlled state read by library code), L
(lifecycle), C (config), B (a browser decision re-derived) and D (derived state). Each class has one chokepoint and a
test that enumerates its domain:

| Class | Chokepoint | Structural test |
| :--- | :--- | :--- |
| E-net | the policy template (`src/lib/csp/csp-generator.ts`), `WORKER_GLOBALS`, the renderer's allowlists; the fetch bridge's frame, its one transport (`src/lib/bridge-frame.ts`) | `src/lib/csp/csp-generator.test.ts`; `test/unit/policy-guarantees.test.ts`; `test/e2e/worker-globals-and-termination.spec.ts`; `test/e2e/strict-renderer.spec.ts`; `test/unit/structural.test.ts`; `test/e2e/fetch-bridge-isolation.spec.ts` |
| E-cpu | the egress table and `CHANNEL_BUDGETS` (`src/lib/egress.ts`); the frame table (`src/lib/frames.ts`) | `test/unit/egress.test.ts`; `test/e2e/egress.spec.ts`; `test/unit/budgets.test.ts`; `test/unit/structural.test.ts` |
| P | the snapshot measure (`src/lib/structured-size.ts`) and the RPC frame builders; `viewBudget` | `test/unit/structural.test.ts`; `test/unit/view-budget.prop.test.ts` |
| G | the capture lists ended by `CAPTURE_POINT`; one read of a guest value | `test/unit/bootstrap-capture-and-measure.test.ts`; `test/unit/read-once.test.ts` |
| L | `reduce` and its executor (`src/lib/lifecycle.ts`); the declared per-environment resources, detached before they are released (`src/lib/environment.ts`) | `test/unit/lifecycle-reducer.test.ts`; `test/unit/lifecycle-model.test.ts`; `test/unit/teardown-reentry.test.ts`; `test/e2e/lifecycle-model.spec.ts` |
| C | `CONFIG_SCHEMA` (`src/lib/config-schema.ts`); `parseOrigin` | `test/unit/config-schema.test.ts`; `test/unit/rate-limit.prop.test.ts`; `src/lib/origin.test.ts` |
| B | the load-kind table (`src/lib/load-kinds.ts`), `VIEW_FILE_TYPES`; a prediction of the browser's that errs only toward refusing, and that no bound depends on | `src/lib/load-kinds.test.ts`; `test/unit/view-css-loads.test.ts`; `test/unit/entry-end-marker.test.ts` |
| D | the one diff of the guest-write overlay (`src/lib/guest-writes.ts`) | `test/unit/guest-writes.test.ts`; `test/unit/call-settling-and-read-once.test.ts` |

An availability finding is rated under the owner's rule ([Availability](#availability)): at most medium when it
qualifies, high when the host page can never regain control or the stall is bounded by nothing the library states.

**Fixing.** A fix names its class and extends that class's list or chokepoint and its structural test, never one
instance only; a new mitigation is a new cost, measured in every engine
([CONTRIBUTING, Fixing a finding](../CONTRIBUTING.md#fixing-a-finding)). Every security change brings a test that
fails against the vulnerable code, in `test/e2e/` or `test/unit/` ([Security changes](../CONTRIBUTING.md#security-changes)).
