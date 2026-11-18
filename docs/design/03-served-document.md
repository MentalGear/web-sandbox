# 03 · The served document

**Status: a design, not built.** [The folder's index](README.md) has the invariants (I11 to I15 are this file's). The
measurements are [research 27](../research/27_served_document_headerless/README.md) and
[research 28](../research/28_served_topology/README.md), on Chromium 159, Firefox 159 and WebKit 27.2.

## The root

Sealed mode's view is a `srcdoc` document today. A `srcdoc` document is the host page's in every way the browser
inherits: its Content-Security-Policy applies to it, its Trusted Types policy governs how the library writes it, and the
library's code that prepares guest content runs in the host page's realm. `INHERITED_CONTEXT`
(`src/lib/inherited-context.ts`) lists what the sandbox inherits, row by row, and much of sealed mode's code exists to
step around one row or another.

The owner's decision (D8): the view's document is a static file the embedder serves, with its own policy in a `<meta>`
tag. No response headers, no server configuration, and no `srcdoc` fallback in the default build.

## The public surface

```ts
defineWebSandbox(options: { tagName?: string; documentUrl: string | URL }): typeof WebSandbox
```

| Piece | What it is |
| :--- | :--- |
| `sealed-document.html` | One static file per library version, shipped in the package and exported as `./sealed-document.html`. The embedder serves it unchanged |
| `documentUrl` | Where the embedder serves it. Given once, at registration, and required. It is resolved against the document's base URL, must be `http:` or `https:`, and carries no user name, password or fragment; anything else throws |
| New termination reasons | The file is missing, the file is another library version's, a start-up gate failed. Their names are set when built |

`documentUrl` is not part of `SandboxApp`: data that describes an app can never choose the document that renders it.

"No backend, no server config" becomes "one static file, no server config".

## The shape

```
host page
└─ <web-sandbox>, closed shadow root
   └─ <iframe src=documentUrl sandbox="allow-scripts">        F, the served file
      └─ <iframe sandbox="allow-scripts" srcdoc="…">          C, the view, in F's static markup
         └─ Worker(blob:)                                     the guest's logic, started by C
```

- **F runs nothing of the guest's, and no script but a guard.** The view, C, is an element of F's static markup, with a
  `sandbox` attribute that has no `allow-same-origin`. C's bootstrap is the library's, pinned by hash in F's policy. C
  starts the worker.
- **The host page posts to C directly**: C is `frames[0]` of F. C accepts exactly one initialisation message, from its
  parent's parent, as today's view does. The ports go from the host page to C, and C hands one to the worker. F handles
  no message.

**Measured** (research 28, Q1): with this shape, C and its worker were opaque and reached nothing of the embedder's
origin in all twelve ways of opening F that research 27 lists (Q2: framed, navigated to and opened as a popup, by the
embedder and by another site, sandboxed and not), on all three engines; eleven on WebKit, whose browser closed in the
twelfth (the sandboxed popup). In the form where F itself ran a script, or started the worker,
that code took the embedder's origin in seven of the twelve.

## Inside the file

| Piece | What it is | Rung | Measured |
| :--- | :--- | :--- | :--- |
| No script of F's own | C in F's static markup; C starts the worker | impossible to build: F runs nothing, an attacker cannot add a script to a static file, and C's `sandbox` attribute is a byte of that file | above |
| The guard | F's one script, before C's markup: if the document is not opaque (`self.origin !== 'null'`) or is the top-level document, `window.stop()` | a check | C was built only when F was framed sandboxed, on all three engines |
| A constant policy | One `<meta>` text per library version: scripts by hash, the still stylesheet by hash, `blob:` for the four kinds of file, `worker-src blob:`, `connect-src 'none'`, everything else `'none'`. No `'unsafe-inline'`, and no generator in the default build | impossible to build, for the policy's text | works with F opaque or not, on all three |
| The channel | ports from the host page to C | impossible to build a relay | the round trip is today's; start-up is 3 to 5 ms more on loopback |
| The start-up gates | below | a check, of the browser | below |

**What the constant policy gives up.** Today's per-build policy admits `blob:` only for the kinds of file the app
registered. A constant policy admits it for all four kinds, and the renderer's URL rule (`keepsUrl`) is then the only
thing that keeps a `blob:` URL of the wrong kind out: that narrowing moves from the policy to a check.

**What the guard does not cover.** Another site can frame F sandboxed and drive the library with its own content. That
content runs opaque, with no authority of the embedder's, but it is at the embedder's URL. A documented limit: in that
case the address bar is the other site's.

## The start-up gates

Before any guest content exists, the file's realms run a list of canaries that confirm the browser enforces what the
design assumes. Research 28 (Q7) measured twelve: origin, framing, code from strings, connect, image, style, base,
frame, cookie, storage, parent, and the worker's network names. A canary that the browser does not refuse ends the build
with a termination reason. Nothing of the guest's has run by then.

| | |
| :--- | :--- |
| Measured | each of the twelve canaries tripped under the mutant that provokes it, on all three engines |
| Cost | 4 to 6 ms of start-up at the median without the frame canary; about 1.6 s with it |
| Left out | the frame canary: it is blind to its own directive while `script-src` holds, and it is the 1.6 s |
| Not covered | a mutant of `frame-src`, `worker-src` or `default-src` alone passes the gates; nothing that changes after start-up is seen |

The gates are defence in depth after the construction, never in place of it: they answer "the browser has a bug or a
setting that dissolves the policy", for the cases a canary can provoke.

## A thinner host

With the view in a document of its own, the passes over guest content that run in the host page's realm today
(`HOST_PASSES`, `src/lib/host-passes.ts`) can leave it.

| Pass | In this design |
| :--- | :--- |
| the entry scan, the module rewrite, the stylesheet scans and cut, the assembly of the worker's source | move into C |
| the policy built from the kinds of file | goes: the policy is constant |
| writing the frame's `srcdoc` through Trusted Types | goes: the host page sets a URL |
| the config's copy and schema, the file store and its quota, the validation and measure of every typed message that comes back, guest writes, log lines, violations | stay: they are the element's own state, or the host page acts on them |

From reading the code; not measured.

## Optional: the file on a second hostname

`documentUrl` may be on another site than the host page. A wrongly opened file then holds that host's authority, never
the embedder's app's (impossible to reach). It is allowed and not required. It does not give the host page its thread
back: a loop in F or C stalled the host page for its whole length on the headless shell, Firefox and WebKit, whatever
the file's site.

## What the served document does not change, and what it adds

- **Does not change:** the permission state keyed to the top-level page (Chromium's view and WebKit's worker read the
  host page's geolocation grant), the secure-context bit, the host page's thread on the engines named above.
- **Adds:** a URL any site can frame; a requirement on the host page's policy (`frame-src` must admit `documentUrl`); a
  deployment step; the WebKit browser closing in one wrong-way case.
- **Makes worse, unless [04](04-forms-and-autofill.md) holds:** a served file has an `http(s)` URL, so Chromium's
  autofill treats the view's fields as a page's.

## The network build

Sealed mode is the same code in both builds, so it is served in both. Strict, cooperative and worker mode keep the
documents they have today.

## Not measured

- Safari, Android, and a shipping browser's third-party storage settings.
- The file as it will ship: research 28's spike ran the library's per-build wrapper as a served file, not one static
  file per version with the real bootstrap hash.
- The host page's Trusted Types and a host policy without `frame-src` for the file, with the library.
- The window before F's `<meta>` applies.
- Memory, and any cost of the extra document beyond start-up time.
