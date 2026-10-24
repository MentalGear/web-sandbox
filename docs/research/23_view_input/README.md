# Research 23: pointer, wheel, scroll and focus input in strict mode

**Question.** Can strict mode's inert view give a guest the input it needs for drag-and-drop, gestures, custom pointer
sliders and virtual scrolling, with no guest code in the view and no guarantee weaker?

**Answer.** Yes, and it is built: [API.md, `sandboxView`](../../API.md#sandboxview-strict-mode). The view forwards
pointer, wheel, scroll and focus events to the worker's `sandboxView.on` handlers, trusted only, as numbers and constants,
their coordinates clamped to the view's box; it coalesces the continuous ones per animation frame and holds them while
the worker has not acknowledged the last frame; and the worker answers with `set(id, { css, scroll })`, from closed
lists. What the guest learns is about its own view only, and less than any cross-origin iframe gets.

- **The events** (`VIEW_EVENT_TYPES`), each behind a subscription, with no config flag:
  - `pointerdown`, `pointerup`, `pointercancel` and `focusin`, `focusout`: discrete, posted at once, as the user raises
    them;
  - `pointermove`, `wheel` and `scroll`: continuous (`VIEW_CONTINUOUS_EVENT_TYPES`), coalesced.
- **Off**, and a later opt-in at most:
  - native drag-and-drop with data (`dragstart`, `dragover`, `drop`): the one surface that would bring host-page or OS
    data (files, `text/html` of a selection) into the guest; pointer events cover in-view drag;
  - `pointerrawupdate`, coalesced and predicted point lists, tilt, twist and contact size;
  - `touch*` and `gesture*`: pointer events and the guest's own `touch-action` cover touch and multi-touch gestures;
  - `relatedTarget`, and `keyup`.
- **The answer**: `set(id, { css })` sets inline properties of one element from `VIEW_STYLE_PROPERTIES` (transforms,
  opacity, visibility, geometry, `z-index`, `cursor` and custom properties), within `VIEW_SET_STYLE_LIMITS`, and
  `set(id, { scroll: { top, left } })` that element's own scroll position.
- **The options of `on()`**: `pointerCapture` (the view captures the pointer for the guest, in the trusted
  `pointerdown`), `rect` (the detail carries the handler's element's rectangle, as `rect`: the worker cannot read layout)
  and `preventDefault` (the view cancels a wheel's default inside the element).
- **Flow control**: at most one entry per pointer (moves) or element (wheel, scroll) waits in the view's input outbox, the
  latest winning and a wheel's deltas summed; what it holds goes to the worker at most once per animation frame, and only
  while no frame is unacknowledged (`VIEW_INPUT_IN_FLIGHT`, 1: the worker's prelude answers each `VIEW_EVENT` with
  `VIEW_EVENT_ACK` once its handlers have returned). A discrete event goes at once, behind what the outbox held. The
  event path's own time is charged to the view's time budget (`VIEW_APPLY_MS_PER_SECOND`). There is no per-second count
  of its own: the frame rate and the acknowledgement bound the rate, the time budget bounds the cost.
- **Measured** on the shipped code (`measure.spec.ts`; below): a 60 Hz drag answered with `set({ css })` is rendered a
  median 28 ms (Chromium), 25 ms (Firefox) and 50 ms (WebKit) after the move, one frame of it the worker's round trip;
  the host page's thread stays 0–3% busy.

## 1. What each event carries

The detail keeps the fields every event has (`type`, `ids`, `target`, `truncated?`). What is new is numbers or constants,
never a string of the guest's and never a URL:

| Event | Kind | Fields | Notes |
| :--- | :--- | :--- | :--- |
| `pointerdown`, `pointerup`, `pointercancel` | discrete | `pointer`, `modifiers`, `time`, `rect?` | `pointer = { x, y, id, kind: 'mouse' \| 'pen' \| 'touch', primary, button, buttons, pressure }`; `x`, `y` in view CSS px, rounded to 0.1 and clamped to `[0, innerWidth] × [0, innerHeight]`; `pressure` rounded to 0.01 |
| `pointermove` | continuous | as above, and `coalesced`, how many raw events it stands for | outside the view's box only while a press that began in the view is held (a button down), and clamped (§3.1) |
| `wheel` | continuous | `wheel = { dx, dy, dz, unit: 'pixel' \| 'line' \| 'page' }`, `pointer = { x, y }`, `modifiers`, `time`, `coalesced` | the deltas of one element and unit are summed while coalesced; another unit is another entry |
| `scroll` | continuous | `scroll = { top, left, width, height, clientWidth, clientHeight }` of the scrolled element, read when the frame is sent; `time`, `coalesced` | the document's own scrolling is its root's; a capture listener on the window (scroll does not bubble) |
| `focusin`, `focusout` | discrete | none | no `relatedTarget`: a `focusout` with no `focusin` after it means focus left the view |

`time` is the event's `timeStamp` in whole milliseconds: no finer than the worker's own clock (the view's
`performance.now()` steps are 0.1 ms in Chromium and 1 ms in Firefox and WebKit, measured), and it lets a fling compute
a velocity without the jitter of arrival times. `rect`, with the `rect` option, is `{ x, y, width, height }` of the
handler's own element, read once per frame of events, never per raw event.

## 2. Flow control, and how the worker answers fast enough

### 2.1 The input outbox

The view keeps one outbox per environment (`viewInputOutbox`, `src/lib/in-sandbox-view.ts`; its arithmetic is a pure
function, which `test/unit/view-input.test.ts` runs, a property test of the in-flight rule included):

1. **Discrete events** are posted at once, as the user raises them, whatever is in flight, behind whatever the outbox
   holds, in one `VIEW_EVENT` frame: a `pointerup` never overtakes the last `pointermove`. They are bounded by the user's
   own input.
2. **Continuous events** wait in one slot per key, the latest winning: a move per pointer id, a wheel per element and
   unit (its deltas summed), a scroll per scrolled element.
3. **One frame unacknowledged** (`VIEW_INPUT_IN_FLIGHT`). The worker's prelude answers each `VIEW_EVENT` with
   `VIEW_EVENT_ACK` once the handlers it dispatched to have returned; only the prelude can post on the render port. The
   view sends what the outbox holds at the next animation frame (a 100 ms timer stands in where frames are throttled,
   as for the render flush), and only while nothing is unacknowledged and the time budget is not in debt. A guest whose
   handler blocks gets nothing more until it returns, and then only the latest state: neither the worker's queue nor
   the host page's thread grows with a stuck guest (the rule A4 gives renders).
4. **Time.** The event path's work in the view (reading the events, building the details, reading rectangles and scroll
   extents, which can force a layout) is measured and charged to `VIEW_APPLY_MS_PER_SECOND`, like the operations, so
   the view's cost statement keeps one bound, and the budget counts the time spent, not a count standing in for it
   (class P, [research 18](../18_finding_classes/README.md)).

Why coalesce when Chromium and Firefox already align pointer events to frames: **WebKit does not.** A burst of moves as
fast as the driver sends them reached WebKit's view 1 386 times a second (`measure.spec.ts`), Chromium's and Firefox's
60, and the guest receives about 60 a second on every engine. Coalescing makes the rate the same on every engine, so no
engine-ledger row is needed for delivery.

### 2.2 The answer

- **`set(id, { css })`** sets inline properties of one element through `style.setProperty`, from the closed list
  `VIEW_STYLE_PROPERTIES`; `null` removes one. No `animation*` or `transition*`, so `allowAnimations: false` holds. A
  value that names a load (`url(`, `image-set(` and the rest; only `cursor` and custom properties can carry one) is
  prepaid to the load budget like a style attribute's (`cssLoadBound`, S73) and refused once the view has loaded
  `VIEW_MAX_DISTINCT_URLS`; the browser applies the view's policy to the load. What the style attribute grows by counts
  against `VIEW_MAX_CHARACTERS`. One inline property of one element is what a drag changes each frame; the other route,
  a rule's text into a `<style>` with `text()`, restyles the whole view each time, and the time budget slows it where
  the view is large.
- **`set(id, { scroll: { top, left } })`** assigns that element's own `scrollTop` and `scrollLeft`: never an ancestor's,
  never the host page's. It is not `scrollIntoView` and not a fragment.
- **`pointerCapture`**, on a `pointerdown` handler with an id: on a trusted `pointerdown` inside that element, the view
  calls `setPointerCapture(pointerId)` on it, synchronously, in the event (the worker would be a frame too late). The
  moves and the release are then retargeted to the element, so `ids` keeps naming it after the pointer leaves it: what a
  slider thumb needs. The platform releases the capture at `pointerup` and `pointercancel`. While a pointer is captured,
  the view cancels `dragstart` and `selectstart` inside its element, so a native drag of a link or an image, or a text
  selection, does not take the gesture (measured: without it, Chromium and Firefox start a native drag of a link and the
  guest's drag stops). Firefox has no CSS for that (`-webkit-user-drag` is Chromium's and WebKit's), and `draggable` is
  no attribute the renderer keeps.
- **`rect`**: the view reads the rectangles the subscriptions ask for (it learns them from `VIEW_LISTEN`'s marks,
  `[type, id, flags]`, at most `VIEW_EVENT_LIMITS.maxIds` elements a type), once per frame of events.
- **`preventDefault`**, on a `wheel` handler: the view cancels the wheel's default inside the element (anywhere for
  `null`), with a listener that is not passive and exists only while such a subscription does. Scrolling over the
  sandbox's box then waits for the view's thread, which is the host page's in Firefox and WebKit, as it does over any
  frame with such a listener.
- **Touch and gestures.** Pinch and two-finger rotation come from two pointer ids. The guest sets `touch-action: none` (or
  `pan-y`) in its own CSS; without it the browser takes the gesture for panning and sends `pointercancel`.

### 2.3 Latency

Measured on the shipped code, `measure.spec.ts`, 2026-10-24: Playwright 1.58.1, headless, on a shared 4-core VM
(Chromium's headless shell 145, where the view shares the host page's thread; Firefox 146; WebKit 26); trusted moves at
60 Hz, about 270 a run; "rendered" is the first task after the frame callback that applied the answer, the end of the
rendering update that showed it, on the view's own clock.

| Engine | Event to rendered, `set({ css })`: p50 / p95 | Host busy: not subscribed / receiving / answering | Burst: raw moves a second in the view / received a second; host busy |
| :--- | :--- | :--- | :--- |
| Chromium | 28.1 / 29.5 ms | 0% / 0% / 0% | 60 / 60; 0–1% |
| Firefox | 25 / 33 ms | 0% / 0% / 1% | 60 / 60; 3% (answering) |
| WebKit | 50 / 61 ms (it rendered 120 of 273 moves: about 30 frames a second under the updates) | 1% / 1% / 3% | 1 386 / 62 receiving, 404 / 27 answering; 8% (answering) |

One frame of it is structural: an asynchronous worker cannot answer within the frame that dispatched the input, so the
answer arrives after that frame has rendered, and the next frame applies it. The rest is the engine's input alignment
(the move is delivered at the start of a frame), the forward and the worker's handler, and the flush and the rendering.
WebKit rendered about 30 frames a second under continuous updates (research 16 saw the same, 27), and moved with the
machine's load.

If one frame is too much, a later option: a declarative `follow`, with which the view itself moves the captured element by
the pointer's delta, in the event, and leaves the result to the worker at `pointerup`; it would need its own row in the
cost statement.

## 3. Threat review

### 3.1 What reaches the guest

| Information | About | Already available to | What the view does |
| :--- | :--- | :--- | :--- |
| Pointer position over the view, buttons, pointer id, primary | the user's interaction with the view | cooperative guests; any cross-origin iframe | forwarded, clamped |
| Pointer position **outside** the view during a press that began in it | the pointer's path over the host page | any iframe: every engine goes on delivering moves to the view past its edges while the press lasts, with or without `setPointerCapture`, and none after the release | **clamped** to the view's box, and a move outside it forwarded only while such a press is held (a button down), so a move outside the box with `buttons: 0` (Firefox delivers some after a release outside the browser's viewport) is dropped too. `test/e2e/strict-pointer-events.spec.ts` drags past the view's edges on every engine: the guest gets coordinates at the edge, none past it, and nothing after the release. So strict mode gives less than an iframe here: the guest learns only the projection onto its own edge, during a drag the user started on its content |
| `kind` (`pointerType`), `pressure` | the device class: pen or touch present | iframes, cooperative guests | forwarded; tilt, twist and contact size are not (biometric, and not needed) |
| Event timing, whole ms | input dynamics in the view (mouse dynamics are a known biometric) | every page and iframe, at a finer resolution | forwarded; nothing of the host page's input reaches the view |
| Wheel deltas and unit | the OS's scroll settings | every page | forwarded |
| Layout readback: `rect`, scroll extents | the guest's own layout: font metrics, zoom, the view's size | the worker has `OffscreenCanvas` `measureText`; the embedder sets the element's size | forwarded |
| `focusin`, `focusout` | when the user enters or leaves the view's controls | iframes (the window's `blur` and `focus`); cooperative guests | forwarded without `relatedTarget` |
| Native drag-and-drop data (`text/html` of a host-page selection, `text/uri-list`, files) | **host-page content or the user's files**, dragged in | iframes, cooperative guests | **not forwarded**: no drag event is subscribable. File inputs give the worker no `File` either (`FormData` drops what is not a string) |

**Nothing of the host page or of other origins.** The view hears only events dispatched in its own document: capture
listeners on its own window, each checking `isTrusted`. With no button held, the host page's own moves around the view
reach nothing (`test/e2e/strict-pointer-events.spec.ts`). Keystroke inference from pointer timing would need the host page's events, and none arrive; typing in the view
reaches the guest through `keydown`, as before.

**Two residuals**, documented ([THREAT-MODEL](../../THREAT-MODEL.md#accepted-risks-and-open-items)):

- **Trusted is not user-caused for `scroll`.** `set({ scroll })` raises a trusted `scroll` event, and `rect` and the
  scroll extents read layout, so a guest can make readback events itself: at most one frame of them per animation frame,
  bounded by the outbox and by the time budget. No bound depends on an event being the user's
  (`test/e2e/strict-scroll-and-wheel.spec.ts` drives such a loop).
- **Find-in-page scrolls the view.** The browser's find bar scrolls the view to a match, and the `scroll` event tells
  the guest that the user searched for text it shows. Iframes and cooperative guests learn the same.

### 3.2 Side channels and UI redress

- **Input timing.** The guest gets arrival times at the worker's `performance.now()` resolution, and the detail's `time`
  in whole milliseconds. No new class: the threat model leaves timing side channels out of scope, and every iframe gets
  finer timestamps.
- **Cursorjacking inside the box.** `cursor: none` and an element that follows the pointer draw a fake cursor, inside
  the element's box only: the view cannot paint outside its frame, moves stop at its edge when no button is held, and
  the host page's cursor returns as soon as the pointer leaves. That is UI spoofing inside the element's box, out of
  scope. Strict mode takes no pointer lock.
- **UI redress.** An element the guest keeps under the pointer can only be inside its own view: an iframe's content is
  clipped to its box, `position: fixed` in the view is relative to the view, and the renderer allows no popover and no
  top layer outside the frame. Clicks land where the real pointer is; the host page's UI is never under the view. A drag
  out of the view carries what it always did: inert `about:blank#` hrefs, image URLs and selected text; there is no
  `setData`, because no guest script exists to call it.

### 3.3 Cost on the host page's thread

- **The event path** is charged to the view's time budget (§2.1), so it is inside the bound of
  [API.md (a)](../../API.md#a-the-long-run-bound), not a row of (d). Measured above: 0–3% of the host page's thread for a
  60 Hz drag answered every frame, 8% on WebKit for a burst as fast as the driver sends it (1 386 raw moves a second).
- **The answers** are view operations: one in flight, metered, and bounded by (a) and (b) as before.
- **`:hover` restyles** while the pointer moves stay where they are: (d), driven by the user.
- **A wheel `preventDefault`** makes scrolling over the box wait for the view's thread while the subscription exists; a
  guest can stop the host page's wheel-scrolling while the pointer is over its box, as any iframe can.
- **Interaction with the existing limits:** `VIEW_EVENT_LIMITS` still bounds each frame (its strings share
  `maxTotal`); liveness, the overrun rule and `VIEW_RENDER_CHARACTERS_PER_SECOND` are unchanged; `set({ css })` charges
  the characters of its names and values, like `value`. The owner's availability rule applies: the cost is bounded,
  and `terminate()` ends it.

### 3.4 Finding classes ([research 18](../18_finding_classes/README.md))

| Class | Touched by | How it stays closed |
| :--- | :--- | :--- |
| E-cpu | the view's new listeners (`pointer*`, `wheel`, `scroll`, `focus*`, and `dragstart` and `selectstart` cancelled) | their rows in `EGRESS` (`src/lib/egress.ts`), relayed or cancelled with their bound; `VIEW_EVENT_ACK` in `FRAMES`; `test/e2e/egress.spec.ts` enumerates every surface of the view |
| P | a count of events standing in for their cost | the event path's time is charged to the time budget; the frame rate and the acknowledgement only bound the message rate |
| G | `on()`'s options object, `set()`'s `css` and `scroll` objects | each read once, as a snapshot, into objects with no prototype, through intrinsics captured before guest code (the capture-point scan; `isStyleProperty` is given a captured `charCodeAt`) |
| B | "trusted" read as "user-caused" (`scroll` raised by `set`); implicit capture per engine; WebKit's uncoalesced delivery | no bound depends on an event being the user's; clamping does not predict the browser's routing, it clips whatever arrives; the outbox makes the rate the same on every engine |
| E-net | `set({ css })` values that can name a URL (`cursor`, `--*`) | the chokepoint of style attributes: each value without its network URLs unless of an origin in `origins.withoutCors` (`cssInto`, as the renderer's; research 21), then `cssLoadBound` and the load budget (S73); the view's policy |
| C | an opt-in such as native drop data, if one is ever added | `CONFIG_SCHEMA`, a literal `true` only, like `allowAnimations` |
| L | pointer capture across `reset()` | capture ends with the view's document; subscriptions are per worker |

## 4. Later, each with a probe of its own

- **A canvas the worker draws into.** `transferControlToOffscreen()` (Chromium 69+, Firefox 105+, Safari 16.4+) would let
  the worker commit frames at its own rate, outside the meter; whether Firefox and WebKit touch the host page's thread per
  commit is not measured. The bounded alternative first: `sandboxView.draw(id, imageBitmap)` into a `bitmaprenderer`
  canvas the view owns, each frame a view operation, one in flight and metered.
- **`follow`** (§2.3), native drop data as an opt-in (`text/plain` only, files as a second level), `keyup` if a use case
  asks.

## Files

- `measure.spec.ts`: the shipped path's latency and host cost, on demand
  (`WEB_SANDBOX_MEASURE=1 bunx playwright test docs/research/23_view_input/measure.spec.ts --project=<engine> --workers=1`).
- The specs that hold the guarantees, on every engine: `test/e2e/strict-pointer-events.spec.ts` (the schema, trusted
  only, clamping, coalescing, a blocked handler), `test/e2e/strict-scroll-and-wheel.spec.ts` (wheel sums, a virtual
  list, the bounded scroll loop, `preventDefault`), `test/e2e/strict-drag-and-slider.spec.ts` (a captured drag, a
  slider, the closed list of `css`), `test/e2e/strict-focus-events.spec.ts`; and `test/unit/view-input.test.ts`.

**Caveats of the measurements.** Headless browsers and Playwright's synthetic input: Chromium and Firefox delivered moves
at 60 a second, WebKit's delivery was not aligned to frames, and real hardware may differ. "Rendered" is the end of the
main-thread rendering update, not the display. Chromium was the headless shell (the view on the host page's thread;
desktop Chromium isolates the view and costs the host page less). WebKit moved with the machine's load.
