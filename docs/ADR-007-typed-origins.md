# ADR-007: Typed origins — the guest policy is a template, the embedder lists origins

**Status**: Accepted · **Date**: 2026-10-14

## Context

A guest's Content Security Policy configured as raw CSP (directive names, source-expression lists merged over a default)
lets the embedder say something dangerous through it: a `;` that emits directives ahead of the fixed ones, `*`, `https:` or
`data:`, a `script-src-elem` that silently takes the library's own bootstrap away, a `default-src` that every unlisted
directive inherits, and CSP Level 3 fallbacks that let `blob:` added for one kind of load reach another. Guarding a raw
surface means a pipeline of removals whose order matters, with a postcondition after every step. The owner's rule is to make
bad states unrepresentable, with one chokepoint; a list of removals is the opposite.

## Decision

**The policy is a fixed template per mode. The embedder lists exact origins per kind of load, and nothing else.**

```js
sandbox.setConfig({ mode: 'strict', origins: { connect: ['https://api.example.com'], images: ['https://cdn.example.com'] } });
```

1. **`origins: SandboxOrigins`.** Its keys are kinds of load, not directives: `connect` (connect-src), `images` (img-src),
   `styles` (style-src), `fonts` (font-src), `media` (media-src), `scripts` (script-src). Each value is a list of exact
   origins.
2. **One origin parser** (`src/lib/origin.ts`, `parseOrigin`), shared with `fetchBridge.allow`
   ([ADR-006](ADR-006-fetch-bridge.md)), reads every entry at the boundary, once, in `setConfig()`. It returns a branded
   `Origin` or null; the parsed policy (`OriginPolicy`, `src/lib/csp/origins.ts`) is frozen. An entry that is not an origin
   is dropped with one warning; dropping only narrows (a kind with nothing left is `'none'`). A non-object `origins` or a
   kind that is not a list refuses the config (`the configuration could not be used`), as any unreadable config does (S26).
3. **One generator** (`src/lib/csp/csp-generator.ts`) fills one template per mode, emitting every directive in a fixed
   order, `'none'` when it admits nothing, so no browser ever consults a fallback chain:

   ```
   cooperative (and worker mode)                      strict view (its worker inherits it)
   default-src 'none'                                 default-src 'none'
   script-src 'unsafe-inline' <scripts> [blob:]       script-src 'sha256-<bootstrap>' ['unsafe-eval']
              ['unsafe-eval']                         script-src-attr 'none'
   style-src 'unsafe-inline' <styles> [blob:]         style-src 'unsafe-inline' <styles> [blob:]
   img-src <images> [blob:]                           img-src <images> [blob:]
   font-src <fonts> [blob:]                           font-src <fonts> [blob:]
   media-src <media> [blob:]                          media-src <media> [blob:]
   connect-src <connect> [blob:]                      connect-src <connect> [blob:]
   worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'  (both)
   ```

   `blob:` is added per kind for the registered files of the build only, from the one load-kind table (`load-kinds.ts`,
   whose rows carry the `origins` key of their kind; `track` folds into `media`), so a file is admitted exactly for the loads
   that may name it ([ADR-004](ADR-004-files-as-blob-urls.md)). Strict mode never reads `scripts` and never adds `blob:` to
   `script-src`. `'unsafe-eval'` comes from `scriptUnsafe` only, in `script-src` only. The generator takes only `Origin`s and
   checks each against the origin pattern again, so even a cast cannot carry a source expression into a policy.
4. **Mode-discriminated types.** `SandboxConfig` is a union keyed by `mode`: `SealedSandboxConfig` (`mode?: 'sealed'`, the
   default, with no `origins` and no `fetchBridge`: [ADR-008](ADR-008-sealed-mode.md)), `StrictSandboxConfig`
   (`mode: 'strict'`, `origins?: StrictSandboxOrigins`, which has no `scripts`), `CooperativeSandboxConfig`
   (`mode: 'cooperative'`) and `WorkerSandboxConfig` (`mode: 'worker'`), the last two with `origins?: SandboxOrigins`.
   `scripts` in strict mode is a compile error, and dropped with a warning at run time (a config from JSON). A config
   without `mode` is a sealed config, so one that names `origins` is a compile error, and refused at run time; `origins`
   is parsed for the mode the config has, so `scripts` is dropped with the strict warning. `setConfig(config: SandboxConfig)` takes the union directly (every option is optional, so `Partial<>`
   is not needed). A config whose mode is chosen at run time type-checks when its `origins` is a `StrictSandboxOrigins`:
   TypeScript then checks it against each mode. The playground's presets are typed that way (`PresetRules`), since the
   playground and the specs run a preset in any mode.
5. **There is no raw option.** `connectionsAllowed` is not an option: if present it is ignored with one warning
   (`connectionsAllowed was removed; use origins`), which fails closed, admitting nothing. Nothing is published
   (`private: true`), so there is no consumer to migrate silently, and no adapter: one would have to decide which raw sources
   are origins, the guard-rail problem again.

6. **The host page's `connect-src` narrows `connect` and `fetchBridge.allow` in the library, not in the browser.** A
   sandbox frame copies its parent's policy list, which can only narrow its own, but the engines differ on what some
   sources admit there (docs/API.md#connect-src-by-engine). So the lists are cut by the page's policy before the guest's
   and the bridge's policies are written, the same on every engine, and a parser of `connect-src` alone keeps an origin
   only where every engine admits it (docs/API.md#your-connect-src). The parser only narrows: a source it does not
   understand admits nothing, `'self'` among them. The policy is the embedder's `hostContentSecurityPolicy` and nothing
   else: no API returns a page's policy, and code that learns it from the page (a request whose violation reports it, a
   frame to make it in, a wait for the answer) predicts the browser's state and errs (BD4:CHL-1, BD4:CHL-2). So a build
   that lists a connect or bridge origin without the option drops both lists, with one warning that says what to pass,
   and never leaves them as configured; `false` says the page sends no policy, and keeps them.

### The accepted grammar, and why

| Accepted | Why |
| :--- | :--- |
| `https://host[:port]` | the one scheme a guest load may use. No policy carries `upgrade-insecure-requests`: the engines disagree on what it does to the `http:` form of a listed `https:` origin (refuse, upgrade, send in cleartext), so every engine refuses that form |
| `wss://host[:port]`, in `connect` only, beside `https://host[:port]`, not in strict mode | WebSocket; meaningless for any other kind. A scheme is matched as written, and the engines disagree on a `wss://host` source alone (docs/API.md#connect-src-by-engine), so an entry without its `https://` twin is dropped with a warning and the pair admits `fetch()` and `WebSocket` on every engine. Strict mode opens no WebSocket (a handshake carries the cookies the browser attaches), so there every `wss://` entry is dropped with a warning (docs/API.md#strict-no-websocket) |
| `http://localhost[:port]`, `http://127.0.0.1[:port]` | local development. Loopback only: a plain-http public origin is a network attacker's |

Refused, each dropped with a warning: scheme-wide sources (`https:`), wildcards (`*`, `*.example.com`, `:*`), every keyword
(`'self'`: engines disagree on it for an opaque origin, S14; `'unsafe-*'`: the library's), `data:` and `blob:` (below), paths,
queries, fragments, credentials, whitespace, `;`, `,`, quotes. The host must be written as the URL parser reads it, compared
after parsing: no IPv4 shorthand (`127.1`), no percent-encoding, no non-ASCII name (write its `xn--` form), no trailing dot, no
underscore (CSP's host grammar has none), no IPv6 literal (CSP's host grammar cannot express `[::1]`; so `fetchBridge.allow`
refuses it too). Case is folded and a default port dropped, so one origin has one spelling. The bridge's rules are `https:`
and `http:` for any host (`FETCH_ORIGIN_RULES`).

### What is unrepresentable rather than dropped

- **`data:` for images, fonts and media.** A `data:` SVG image opened in a new tab is a document that runs its script outside
  the sandbox (ST1); registered files cover the need.
- **Every directive but the six.** `frame-src`, `object-src`, `base-uri`, `form-action`, `manifest-src` are `'none'`,
  `worker-src` is `blob:` (a `data:` SharedWorker ran outside the policy in WebKit, PD1), `default-src` is `'none'`;
  `prefetch-src` is not emitted (not in CSP Level 3; Chromium warns about it; an engine that reads it falls back to
  `default-src 'none'`). The directives a `<meta>` policy ignores (`frame-ancestors`, `report-uri`, `report-to`, `sandbox`,
  S7) cannot be named at all.
- **Refusing the bootstrap.** Cooperative `script-src` always starts with `'unsafe-inline'` and never holds a nonce, a hash or
  `'strict-dynamic'` (a property test says so), so the library's inline bootstrap always runs where scripts are allowed.
- **Inline styles** are always allowed: there is no switch.
- **Narrowing what registered files load.** An empty kind admits no origin; the files the embedder registers still load (their
  `blob:` is the library's source, ADR-004). To keep a file out, do not register it.
- **`blob:` for one kind reaching another.** Every directive is explicit, so nothing falls back (PA1), and a property test
  over random origins and file types says so.

## Alternatives considered

- **Keep a raw option and add a typed layer on top.** Two surfaces, and the raw one still needs every guard rail. Rejected.
- **Accept `https:` or `*.example.com`.** Convenient, and each is an allowlist the embedder cannot enumerate. An embedder who
  means many origins lists them.
- **Adapt the raw option to `origins`.** An adapter would have to decide which raw sources are origins: the guard-rail problem
  again. With nothing published, a warning and fail-closed is the honest migration.
- **A separate refuse-build check for a policy that blocks the bootstrap.** Unreachable once the template fixes `script-src`;
  the property test replaces it.

## Consequences

- One parse and one template replace a pipeline of policy steps; the policy for a config can be read off the template.
- The guarantees those steps held hold by construction: S7, S9, S14, S16, S19, PD1, PA1, ST1, F5 (tests:
  `src/lib/origin.test.ts`, `src/lib/csp/origins.test.ts`, `src/lib/csp/csp-generator.test.ts`,
  `test/unit/policy-guarantees.test.ts`, and the e2e specs that assert them per engine).
- An embedder who relies on a raw source (`data:` images, `https:`, a `default-src` for everything) has to list origins, or
  register files. A raw option maps to `origins` by kind of load (`connect-src` to `connect`, `img-src` to `images`, and so
  on); `'self'`, `*`, `https:`, `data:` and `blob:` are not expressible, and `base-uri`, `form-action`, `frame-src`,
  `worker-src` are fixed by the template.

History: [what this ADR replaced, with the migration table](archive/adr/ADR-007-history.md).
