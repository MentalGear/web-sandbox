# CSP Logic for application

- Input: JSON
- Output: CSP string

# Rules Application
- default: only the directives the shipping config sets (see `DEFAULT_SANDBOX_CONFIG` in `src/host.ts`)
- then add directives from user (each array replaces the default's)
- if directive === [] (empty, after blank strings are dropped): emit `'none'` (backlog S16)
    - `[]` always means deny, for every directive
    - to use the `default-src` fallback, leave the directive out instead
    - never omitted: an omitted fetch directive falls back to `default-src`, an omitted `base-uri` /
      `form-action` is unrestricted (research 12), and an empty `default-src` used to replace the
      built-in `'none'`, leaving every unset fetch directive unrestricted
- `default-src 'none'` is always added when the config has no `default-src`

# Validation/Sanitation
- filter out duplicates in directive list
- [""] or [undefined] content should be normalized to []
- better: runtime check if type is different from array or is [""] show error and tell dev to remove it
    -> if we do transformations/sanitaztion, we end up with too much logic we need to maintain and too much different "valid" json inputs
- should we check if values are valid csp or domains ? No, since the browser will just ignore them if they are not. And we need to keep this logic as small and straight-forward as possible as a lot depends on it.

## Tasks
[] write function
[] write tests
    - must have: an empty [] directive is emitted as 'none'; a directive not defined is not present in the output
[] maybe add a vite csp nounce generator so "script-src": ["'unsafe-inline'"] can be dropped
[] interesting for testing: google csp evaluator https://github.com/google/csp-evaluator

## Example

**Input**

```json
{
    "default-src": ["'none'"],
    "script-src": ["'unsafe-inline'"], // never 'self' (dropped for the guest, see drop-self.ts). maybe we can delete 'unsafe-inline' as well and it work for normal on-page js ? only if svelte/vite csp generates nounce for each script
    "base-uri": [], // 'none'
    "style-src": ["'unsafe-inline'"], // might be required to dynamically change colors
    "form-action": [], // 'none'
    "worker-src": ["blob:", "data:"]
    // connect-src, img-src, … are left out: they fall back to default-src. Listed as [] they would be 'none'.
},
```

**Output**

```js
const csp_string = `default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; style-src 'unsafe-inline'; form-action 'none'; worker-src blob: data:;`;
```

## Why not an external csp lib?
Rules are simple enough to write self, and this avoid an external dependency that might get compromised.
