# ADR-007: Typed origins — the guest policy is a template, the embedder lists origins

**Status**: Accepted · **Date**: 2026-10-14 · **Amended**: 2026-10-15 ([strict is the default](#amendment-2026-10-15-strict-is-the-default))

## Why this ADR exists

The guest's Content Security Policy used to be configured as raw CSP: `connectionsAllowed`, an object of directive
names and source-expression lists merged over a default. Every review of 2026-10 found a way to say something
dangerous through it, and every fix added a guard rail that removed what had been said:

| Guard rail | What it dropped |
| :--- | :--- |
| `policy-grammar.ts` (S19) | unknown directive names, anything that was not one source expression (`;` injection) |
| `drop-meta-ignored.ts` (S7) | `frame-ancestors`, `report-uri`, `report-to`, `sandbox` |
| `drop-eval.ts` (S20) | `'unsafe-eval'`, `'wasm-unsafe-eval'` |
| `drop-data-workers.ts` (S34) | `data:` from whatever governed worker loads |
| `drop-self.ts` (S14) | `'self'`, whose meaning differs per engine in an opaque origin |
| `effective-directive.ts` (S20, S34) | the CSP Level 3 fallback table, `assertWidensOnly` after every step, `addEvalSource` |
| `strict-policy.ts` (ADR-005) | everything strict mode did not pass through, and `data:` from images (ST1) |
| `inlineScriptsAllowed` (S13, S20) | a warning when the config refused the library's own inline bootstrap |

Each was correct, and together they were a pipeline of eight steps whose order mattered, with a postcondition after
every step because one step could widen what another kind of load fell back to (PA1). The surface still accepted
`*`, `https:` and `data:`, a `script-src-elem` that silently took the bootstrap away, and a `default-src` that every
unlisted directive inherited. The owner's rule is to make bad states unrepresentable, with one chokepoint; a list of
removals is the opposite.

## Decision

**The policy is a fixed template per mode. The embedder lists exact origins per kind of load, and nothing else.**

```js
sandbox.setConfig({ origins: { connect: ['https://api.example.com'], images: ['https://cdn.example.com'] } });
```

1. **`origins: SandboxOrigins`** replaces `connectionsAllowed`. Its keys are kinds of load, not directives:
   `connect` (connect-src), `images` (img-src), `styles` (style-src), `fonts` (font-src), `media` (media-src),
   `scripts` (script-src). Each value is a list of exact origins.
2. **One origin parser** (`src/lib/origin.ts`, `parseOrigin`), shared with `fetchBridge.allow` (ADR-006), reads every
   entry at the boundary, once, in `setConfig()`. It returns a branded `Origin` or null; the parsed policy
   (`OriginPolicy`, `src/lib/csp/origins.ts`) is frozen. An entry that is not an origin is dropped with one warning;
   dropping only narrows (a kind with nothing left is `'none'`). A non-object `origins` or a kind that is not a list
   refuses the config (`the configuration could not be used`), as any unreadable config does (S26).
3. **One generator** (`src/lib/csp/csp-generator.ts`) fills one template per mode, emitting every directive in a fixed
   order, `'none'` when it admits nothing, so no browser ever consults a fallback chain:

   ```
   cooperative (iframe and worker mode)               strict view (its worker inherits it)
   default-src 'none'                                 default-src 'none'
   script-src 'unsafe-inline' <scripts> [blob:]       script-src 'sha256-<bootstrap>' ['unsafe-eval']
              ['unsafe-eval']                         script-src-attr 'none'
   style-src 'unsafe-inline' <styles> [blob:]         style-src 'unsafe-inline' <styles> [blob:]
   img-src <images> [blob:]                           img-src <images> [blob:]
   font-src <fonts> [blob:]                           font-src <fonts> [blob:]
   media-src <media> [blob:]                          media-src <media> [blob:]
   connect-src <connect> [blob:]                      connect-src <connect> [blob:]
   worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none';
   upgrade-insecure-requests                          (both)
   ```

   `blob:` is added per kind for the registered files of the build only, from the one load-kind table
   (`load-kinds.ts`, which gained a `key` per kind; `track` folds into `media`), so a file is admitted exactly for the
   loads that may name it (ADR-004). Strict mode never reads `scripts` and never adds `blob:` to `script-src`.
   `'unsafe-eval'` comes from `scriptUnsafe` only, in `script-src` only. The generator takes only `Origin`s and checks
   each against the origin pattern again, so even a cast cannot carry a source expression into a policy.
4. **Mode-discriminated types.** `SandboxConfig` is a union keyed by `mode`: `CooperativeSandboxConfig`
   (`mode?: 'iframe' | 'worker'`, `origins?: SandboxOrigins`) and `StrictSandboxConfig` (`mode: 'strict'`,
   `origins?: StrictSandboxOrigins`, which has no `scripts`). `scripts` in strict mode is a compile error, and dropped
   with a warning at run time (a config from JSON). `setConfig(config: SandboxConfig)` takes the union directly (every
   option is optional, so `Partial<>` is no longer needed). A config whose mode is chosen at run time type-checks when
   its `origins` is a `StrictSandboxOrigins`: TypeScript then checks it against each mode. The playground's presets
   are typed that way (`PresetRules`), since the playground and the specs run a preset in any mode.
5. **`connectionsAllowed` is removed, with no adapter.** If present it is ignored with one warning
   (`connectionsAllowed was removed; use origins`): it fails closed, admitting nothing. Nothing is published
   (`private: true`), so there is no consumer to migrate silently.

### The accepted grammar, and why

| Accepted | Why |
| :--- | :--- |
| `https://host[:port]` | the one scheme a guest load may use; `upgrade-insecure-requests` is always on |
| `wss://host[:port]`, in `connect` only | WebSocket; meaningless for any other kind |
| `http://localhost[:port]`, `http://127.0.0.1[:port]` | local development. Loopback only: a plain-http public origin is a network attacker's |

Refused, each dropped with a warning: scheme-wide sources (`https:`), wildcards (`*`, `*.example.com`, `:*`), every
keyword (`'self'`: engines disagree on it for an opaque origin, S14; `'unsafe-*'`: the library's), `data:` and `blob:`
(below), paths, queries, fragments, credentials, whitespace, `;`, `,`, quotes. The host must be written as the URL
parser reads it, compared after parsing: no IPv4 shorthand (`127.1`), no percent-encoding, no non-ASCII name (write its
`xn--` form), no trailing dot, no underscore (CSP's host grammar has none), no IPv6 literal (CSP's host grammar cannot
express `[::1]`; so `fetchBridge.allow` refuses it too). Case is folded and a default port dropped, so one origin has
one spelling.

### What became unrepresentable rather than dropped

- **`data:` for images, fonts and media.** A `data:` SVG image opened in a new tab is a document that runs its script
  outside the sandbox (ST1); registered files cover the need. Before, strict mode dropped `data:` from images only.
- **Every directive but the six.** `frame-src`, `object-src`, `base-uri`, `form-action`, `manifest-src` are `'none'`,
  `worker-src` is `blob:`, `default-src` is `'none'`; `prefetch-src` is not emitted (not in CSP Level 3; Chromium warns
  about it; an engine that reads it falls back to `default-src 'none'`). The S7 directives cannot be named at all.
- **Refusing the bootstrap.** Cooperative `script-src` always starts with `'unsafe-inline'` and never holds a nonce, a
  hash or `'strict-dynamic'` (a property test says so), so the library's inline bootstrap always runs where scripts are
  allowed. The warning for a policy that refused it, and the check behind it, are gone.
- **Inline styles** are always allowed: there is no switch.
- **Narrowing what registered files load.** An empty kind admits no origin; the files the embedder registers still
  load (their `blob:` is the library's source, ADR-004). To keep a file out, do not register it.

### Deleted

`drop-meta-ignored.ts`, `drop-eval.ts`, `drop-data-workers.ts`, `drop-self.ts`, `policy-grammar.ts`,
`effective-directive.ts` (the fallback table, `assertWidensOnly`, `addEvalSource`), `file-sources.ts` (folded into the
generator), `strict-policy.ts` (`strictViewDirectives`, `strictPolicyOverrides`; the view's template is in the
generator), `inlineScriptsAllowed`, the public `CSPDirectives`, the element's `_getCSPDirectives` and the `_warned*` sets
that served the drops. The violation buckets of the strict view read `VIOLATION_DIRECTIVES` (`violation.ts`) instead of
the grammar's list.

## Alternatives considered

- **Keep `connectionsAllowed` and add a typed layer on top.** Two surfaces, and the raw one still needs every guard
  rail. Rejected.
- **Accept `https:` or `*.example.com`.** Convenient, and each is an allowlist the embedder cannot enumerate. An
  embedder who means many origins lists them.
- **Adapt `connectionsAllowed` to `origins`.** An adapter would have to decide which raw sources are origins: the
  guard-rail problem again. With nothing published, a warning and fail-closed is the honest migration.
- **A separate refuse-build check for a policy that blocks the bootstrap.** Unreachable once the template fixes
  `script-src`; the property test replaces it.

## Consequences

- One parse and one template replace eight policy steps; the policy for a config can be read off the template.
- The guarantees the steps held still hold, now by construction: S7, S9, S14, S16, S19, PD1, PA1, ST1, F5 (tests:
  `src/lib/origin.test.ts`, `src/lib/csp/origins.test.ts`, `src/lib/csp/csp-generator.test.ts`,
  `test/unit/policy-guarantees.test.ts`, and the e2e specs that assert them per engine).
- An embedder who relied on a raw source (`data:` images, `https:`, a `default-src` for everything) has to list
  origins, or register files.

## Migration

| `connectionsAllowed` | `origins` |
| :--- | :--- |
| `{ 'connect-src': ['https://api.example'] }` | `{ connect: ['https://api.example'] }` |
| `{ 'img-src': ['https://cdn.example'], 'font-src': […] }` | `{ images: ['https://cdn.example'], fonts: […] }` |
| `{ 'script-src': ["'unsafe-inline'", 'https://cdn.example'] }` | `{ scripts: ['https://cdn.example'] }` (inline scripts are always allowed) |
| `{ 'default-src': ['https://a.example'] }` | list the origin under each kind that needs it |
| `'self'`, `*`, `https:`, `data:`, `blob:` | not expressible: list origins; register files |
| `base-uri`, `form-action`, `frame-src`, `worker-src`, … | fixed by the template |

## Amendment (2026-10-15): strict is the default

[ADR-005's amendment](ADR-005-strict-mode.md#amendment-2026-10-15-strict-is-the-default-cooperative-modes-limits-are-frozen)
made strict mode the default and renamed `'iframe'` `'cooperative'`. The union keeps its shape with the default on
the strict side: `StrictSandboxConfig` (`mode?: 'strict'`) and `CooperativeSandboxConfig` (`mode: 'cooperative' |
'worker'`, required). So a config without `mode` is a strict config, and `origins.scripts` there is a compile error;
at run time `origins` is parsed for the mode the merged config has, the default included, so `scripts` is dropped with
the strict warning. The cooperative template is unchanged.
