# Probe Method

The findings in [Research 11](../README.md) were measured with these scripts rather than derived
from the specification, because several of them (11.2, 11.4) depend on parser and scheduling
behaviour that the spec does not pin down.

## Environment

| | |
| :--- | :--- |
| Date | 2026-08-29 |
| Browser | Chromium 1194 (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) |
| Driver | Playwright 1.58.1, launched directly from Node — **not** through the repo's e2e config, which does not currently run (backlog T1) |
| Server | `bun run dev` (Vite, port 4444) |
| Page under test | `http://localhost:4444/playground/index.html` |

## Running them

```bash
bun install
bun run dev &                      # must be reachable on :4444
node docs/research/11_meta_csp_delivery/probes/<probe>.mjs
```

The scripts hard-code the Chromium path above; adjust `executablePath` for another machine.

## Probes

| Script | Finding | What it measures |
| :--- | :--- | :--- |
| `11_2-where-the-meta-lands.mjs` | 11.2 | Builds five document shapes, reports which parent element the CSP `<meta>` ends up in and whether an image under `default-src 'none'` still loads. |
| `11_3-injection-swallowed-by-comment.mjs` | 11.3 | Loads a payload whose comment captures the injected block, then reports from **inside** the sandbox whether a CSP meta exists in the parsed DOM and whether a fetch escapes. |
| `11_4-pre-policy-egress-race.mjs` | 11.4 | Runs each injection branch five times on a fresh page, counting requests that reach the network and recording the originating frame. |

## A note on method

Two earlier measurements suggested branch-specific bypasses (`<head lang="en">`, and the template
branch). Both were **artifacts of reusing one page across cases** — requests from a previous
case's frame were still in flight and were attributed to the next. They did not reproduce once
each case got a fresh page.

Every probe here therefore opens a new page per case, and 11.4 repeats each case five times
because the effect it measures is racy. Any future probe in this repo should do the same: a
single-run browser measurement of a timing-sensitive property is not evidence.
