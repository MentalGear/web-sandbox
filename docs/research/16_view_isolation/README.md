# Research 16: where the strict view runs, and what it can cost the host page

**Measured on headless Playwright 1.58.1 (Chromium, its headless shell, Firefox and WebKit builds) on a 4-core VM**,
2026-10. Numbers are host-page main-thread busy time unless said otherwise. They are this machine's; the shapes (which
engine shares the thread, what stays busy) are what the decisions rest on.

Decisions taken from it: [ADR-005, "The switches"](../../ADR-005-strict-mode.md#the-switches-allowanimations-and-allowautoplay)
(`allowAnimations`, `allowAutoplay`) and [its time budget](../../ADR-005-strict-mode.md#the-views-budgets) (the rendering meter).

## Where frames run

Method: a 2 s busy loop in the frame, and a timer on the host page; a host timer that stalls for the loop means the
frame runs on the host page's thread.

| Engine | The view (a sandboxed `srcdoc` frame in a sandboxed wrapper) |
| :--- | :--- |
| Chromium, desktop build | Its own process. Chromium 127+ isolates sandboxed iframes (`IsolateSandboxedIframes`); with the feature disabled the view is back on the host page's thread. |
| Chromium headless shell | The host page's thread. |
| Firefox | The host page's thread. Fission isolates only cross-site frames, and an opaque-origin sandboxed frame is placed by its creator's site. Playwright's Firefox ships with Fission's isolation strategy set to 0 (isolate nothing). |
| WebKit / Safari | The host page's thread: no site isolation is shipped. |
| Android | Chromium isolates partially; Android WebView has no out-of-process iframes. |

Rendering placement always followed script placement.

## What keeps a shared thread busy

5 000 animated elements in strict mode, on a shared thread. Idle baselines: Chromium 1%, Firefox 4%, WebKit 17%.

| Vector | Host busy |
| :--- | :--- |
| CSS animation (any property, inline style, `::before`) | 81–92% (Firefox 21–89%, by property) |
| Transitions (`@starting-style`, hover) | 75–87% |
| Scroll-driven animation | Chromium 47–90%, WebKit 82–92% |
| `:hover ~` sibling restyle while the pointer moves (not an animation; user-driven) | 80–100% |
| Animated PNG × 2 000 | WebKit 39%, Firefox 12% |
| `<video autoplay muted loop>` × 20 | up to +6 points |
| Indeterminate `<progress>` × 5 000 | up to +4 points |

None of these is the view doing anything: once rendered they run on their own, so the view's time budget, which
measures what the view does, cannot see them.

## The switch

What brought every animation and transition vector back to the idle baseline on all three engines:

- a library stylesheet placed first in the view's head: an **anonymous** `@layer { … }` holding
  `*{animation:none!important;transition:none!important}`, plus one separate rule per pseudo-element (`*::before`,
  `*::after`, and every other one the renderer's elements can have: `::marker`, `::placeholder`, `::selection`,
  `::backdrop`, `::file-selector-button`, the form controls' engine-prefixed parts …). One pseudo-element an engine does
  not support in a selector list drops the whole rule, hence one rule each;
- the renderer stripping every `animation*` and `transition*` longhand, `-webkit-` prefixed ones included, from inline
  `style=""` attributes. An inline `!important` beats layered rules: without the stripping the host stayed 90–95% busy.

It held against the guest's unlayered `!important`, its own anonymous or named layers, `::before`, `@starting-style`,
hover transitions and scroll-driven animation (`animation-timeline`). The layer must be anonymous, so the guest cannot
append rules to it, and the sheet must come before anything the guest renders (renders only reach the body).

As built (`test/e2e/view-switches.spec.ts`, all three engines): with `allowAnimations: false`, `document.getAnimations()`
in the view is empty against every vector above plus `@property`, a registered stylesheet and the one it `@import`s,
SVG `<style>` and an SVG `style` attribute; the host page's ticks with 5 000 animated elements equal idle (Chromium
300/300, Firefox 286/288, WebKit 249/249 per 3 s), against 17, 27 and 26 with the default. 300 animated form-control
parts (range thumbs, file buttons): idle with the switch; with the default Firefox lost half its ticks and WebKit a
third (Chromium none).

## Rejected: a meter and an actuator

The alternative measured: watch the host page's load and pause what animates when it is too high.

- Pausing animations one by one (`getAnimations().forEach(a => a.pause())`) made things worse: Chromium reached 100%
  busy, with one 9.7 s frame.
- A freeze stylesheet switched on by the meter held Chromium and Firefox only while the view was visible. In WebKit it
  stayed at 49–66% against a target of 37%.
- The meter was blind to off-screen views in Firefox and to hidden or off-screen views in WebKit, which keep animating
  there with no frame to measure.

A switch the embedder sets, in force from the first render, has none of these problems.

## The time budget's rendering measure

At 16c545b the view charged each flush's rendering as the wall time from the flush to its next animation frame, minus
one frame, from a callback queued per flush. Hidden for 5 s with one render applied meanwhile, the next render after
showing waited 18.3 s (Chromium, desktop build and headless shell, under `display:none` and off-screen; Firefox under
`display:none`; WebKit off-screen): frames do not run while hidden or off-screen, so every queued callback charged its
whole age once they did. And up to one frame per flush went uncharged, so the measured load was 22–25% against a 20%
budget.

A "gap" meter has no idle overhead: the time from the end of the view's animation-frame callback to the first task after
it, which is the rendering update that follows. As built, with the flush's layout forced by hit testing
(`elementFromPoint`: WebKit lays a 250 000-character textarea out in 1.6–2 s, before the next frame's callbacks, and
`offsetHeight` or `getBoundingClientRect()` on the body do not make it), at most one measurement outstanding and the
debt capped at one second of the view's time: the render after showing applies in 11–70 ms on all three engines, and
a flood of re-renders takes 15–23% of the host page's ticks (`test/e2e/view-budget.spec.ts`).

## What measuring the budget costs

`measure.spec.ts`, on demand (`WEB_SANDBOX_MEASURE=1`): 4 s windows; busy % from a 10 ms interval's lost ticks, the
host page's frames per second, and, in the view, frame requests, flushes and the time of each part of the accounting
(the view's source rewritten in flight, so the bootstrap's hash still matches; `performance.now()` is coarse in the
sandboxed view, so per-flush times are averages over a few hundred flushes).

**(a) Idle**, a strict view that does nothing (busy %, fps):

| | No sandbox | Before (32ee7fd) | After |
| :--- | :--- | :--- | :--- |
| Chromium | 0%, 60 | 0%, 60 | 1%, 60 |
| Firefox | 4–6%, 60 | 5%, 60 | 5%, 60 |
| WebKit | 17–18%, 61 | 17%, 61 | 17%, 61 |

No frame is requested and nothing runs: the idle view costs nothing, before or after.

**(b) Per flush**, a guest calling `text()` as fast as the view takes it (one flush per frame, 60/s; WebKit 27/s), the
accounting on against stubbed out (the meter and the forced layout doing nothing):

| | Charges + meter request + gap timer | Forced layout | Busy %, on / stubbed | fps, on / stubbed |
| :--- | :--- | :--- | :--- | :--- |
| Chromium | 39 µs | 350 µs | 0 / 0 | 60 / 60 |
| Firefox | 75 µs | 351 µs | 5 / 6 | 60 / 60 |
| WebKit | 28 µs | 458 µs | 18 / 22 | 27 / 26 |

The forced layout is layout the rendering update would otherwise do (here, of a one-paragraph change), moved into the
flush so that it is measured; the accounting itself is tens of microseconds per flush. The host page's busy time is
unchanged within noise. In WebKit a guest that updates as fast as the view takes it halves the host page's frame rate
(61 → 27 fps) with or without the accounting, its busy time unchanged; the earlier build's extra frame callback per
flush happened to hold its flushes to every other frame (31/s), where the host kept 55 fps.

**(c) While animations are allowed**: an idle view with 20 running CSS animations requests no animation frame (0 per
second on all three engines, before and after) and runs nothing of the budget's: the meter runs only after a flush.

## What the browser does with a render's URLs

The time budget charges what the view does: its flush, the layout it forces and the rendering update that shows it.
What the browser does afterwards with the URLs the render holds (fetching, decoding and laying out an image, or
processing the refusal of one the policy refuses) is not the view's work, and runs on the host page's thread wherever
the view does. Measured on headless Playwright 1.58.1, host ticks of a 10 ms interval over 8 s against idle, renders
replacing the same target as fast as the view acknowledged them (`test/e2e/review-round-4.spec.ts`, M-2):

| Renders of | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| 6 500 `<img alt>`, no source (control) | 19% | 14% | 10% |
| 6 500 `<img>` of a refused source, before the renderer dropped them | 31% | 45% | 21% |
| the same, dropped by the renderer | 17% | 21% | 14% |
| one render of 4 000 new images from an admitted loopback origin (the 8 s after it) | 52% | 46% | 19%¹ |
| 1 000 new images from an admitted origin, at `VIEW_MAX_URLS` 1 000 and `VIEW_URLS_PER_SECOND` 200 (loopback) | 14% | 19% | 5%¹ |
| the same, served by the test | 12% | 9% | 8% |
| 3 000 elements, each with a background from a refused source (CSS, not dropped) | 18% | 33% | 9% |

¹ WebKit upgrades the loopback's `http:` to `https:` (`upgrade-insecure-requests`) and the request fails.

An admitted image costs the host page about a millisecond, so the cap bounds what one render can make the browser do
(about a second of the host page's thread) and the rate keeps the long-run share near the view's own 20%. Every kept
URL is charged, a cached or relative one too: what one costs the browser is not known when it is rendered.
