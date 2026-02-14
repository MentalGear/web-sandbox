# CSP Logic for application

- Input: JSON
- Output: CSP string

# Rules Application
- default: directive = [] (empty)
- then add directives from user
- if directive === [] (empty): ignore
    -> do not include directive in csp header
        - this makes the browser use default-src for this (unnamed) directive
        - otherwise if we were to fill in "none", it would overwrite "default-src" which we do not want

# Validation/Sanitation
- filter out duplicates in directive list
- [""] or [undefined] content should be normalized to []
- better: runtime check if type is different from array or is [""] show error and tell dev to remove it
    -> if we do transformations/sanitaztion, we end up with too much logic we need to maintain and too much different "valid" json inputs
- should we check if values are valid csp or domains ? No, since the browser will just ignore them if they are not. And we need to keep this logic as small and straight-forward as possible as a lot depends on it.

## Tasks
[] write function
[] write tests
    - must have: empty [] or none defined directive should never be present in output
[] maybe add a vite csp nounce generator so "script-src": ["'unsafe-inline'"] can be dropped
[] interesting for testing: google csp evaluator https://github.com/google/csp-evaluator

## Example

**Input**

```json
{
    "default-src": ["'none'"],
    "script-src": ["'self'", "'unsafe-inline'"], // maybe we can delete 'unsafe-inline' as well and it work for normal on-page js ? only if svelte/vite csp generates nounce for each script
    "connect-src": [], // we can't add 'none' as default to all the items since that would overwrite the default-src. if empty, we must remove the whole directive later.
    "base-uri": [],
    "img-src": [],
    "style-src": ["'unsafe-inline'"], // might be required to dynamically change colors
    "font-src": [],
    "media-src": [],
    "manifest-src": [],
    "prefetch-src": [],
    "form-action": [],
    "object-src": [],
    "frame-src": [],
    "frame-ancestors": [],
    "worker-src": ["blob:", "data:"]
},
```

**Output**

```js
const csp_string = ` default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'blob:' 'data:' ;`;
```

## Why not an external csp lib?
Rules are simple enough to write self, and this avoid an external dependency that might get compromised.
