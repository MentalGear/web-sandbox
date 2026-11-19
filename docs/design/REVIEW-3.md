# Review 3: steps 1 and 2 as built

**Status: a review of the code at `7dfec16`**, steps 1 and 2 of [05](05-build-order.md) as built, against
[the invariants](README.md#the-invariants) I1 to I10 and I17 and files [01](01-one-element-one-app.md) and
[02](02-what-an-app-hands-over.md). One reviewer, who wrote none of it and read neither review 1's nor review 2's
reasoning beyond what the repository holds. Priority went to what had no review yet: the commit by identity (I4), the
measure's refusal of `Blob` and `File` (I7), a write's type from its path (I8), `GuestBytes` (I9), `links` (I6) and
`GUEST_VALUES` (I10). Nothing in `src/` or `test/` was changed; the probes and their output are in
[review-3/](review-3/mutations-output.txt). Probes ran on Playwright's Chromium, Firefox and WebKit builds of this
checkout (loopback only, under the machine's shared lock). Each finding says whether it was run or only read.

## Verdict in brief

- **One data finding, on Firefox, in `links`** (finding 1, run). One held key opens a tab for each of its repeats: one
  press of Enter held over a link the guest had focused opened 10 tabs, with the popup blocker on, 5.5 s after the user's
  last click. The guest moved the focus while the key was held, so the repeats carried two listed URLs. The egress row's
  bound, "at most one tab a click (window.open consumes the click's activation)", fails open per user action. Each
  repeat is a choice among the listed URLs, so the bits a listed server receives grow with the time the key is held.
  Chromium opened one tab for the same input.
- **The constructions hold where they were attacked.** The commit by identity resisted every race and argument trick I
  could build (probe 3). The measure refused a `Blob` and a `File` in every container I put them in (probe 5).
  `image()`'s `Blob` stayed an image on three engines, opened top-level, in an `<iframe>`, an `<object>` and an
  `<embed>`, with HTML and SVG behind each signature (probe 1). `save()`'s names kept `.download` on every edge case of
  a valid path on three engines, Firefox's truncation of a 265-character name included (probe 2).
- **The named tests catch the vulnerable forms.** Eight of nine mutants of the I4, I6, I7, I8 and I9 mitigations fail
  their named test; the ninth is an equivalent mutant ([mutations-output.txt](review-3/mutations-output.txt)).
- **The rest is low:** the docs say a focused link's Enter is a click but not that the guest picks the focus (2); the
  write-time quota admits a write no commit can ever take (3); `GUEST_VALUES` files numbers and choices the guest makes
  as the library's (4); and resizable buffers, which the measure counts by their length while their clone keeps a
  maximum of 1 GiB (5, availability).
- `test/unit/doc-links.test.ts` fails while no doc links this file. I changed no existing doc, so a link from
  [the folder's index](README.md) is left to the authors.
- No test was changed to fit the code in the history of these steps. The assertions removed since `8d65ce6` belong to
  removed members (`setConfig`, `registerFiles`, a guest-given type) or were rewritten with the same subject
  (`content.bytes()` for `content`, a raster name for a type override).

## Findings

| # | Severity | Class | Invariant | Run or read | Engines |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | medium | data leak (a channel's bound fails open: CONTRIBUTING's exception 3) | I6, the `links` egress row | run | Firefox (Chromium holds; WebKit has no blocker to measure) |
| 2 | low | docs | I6 | run (by the repository's own spec), read | all |
| 3 | low | correctness, docs | I4's module comment, the write-time quota | run | engine-independent (unit) |
| 4 | low | docs (classification) | I10 | read | both builds |
| 5 | low (backlogged) | availability, correctness | I7's measure (not its refusal of `Blob`) | run | Chromium (a message lost); all three keep the maximum |

### 1. One held key opens a tab per repeat on Firefox, and the guest picks the URL of each

- **Breaks:** the `links` row of the egress table (`src/lib/egress.ts`). Its `count` says "the browser opens at most one
  tab a click", its `host`/`window.open` row "at most one a click (window.open consumes the click's activation; research
  30)", and docs/API.md says "A click is a choice among the listed URLs, at most log₂ of their number in bits". I6 says
  "an intact view asks for a tab only in the user's click on a listed link".
- **Attacker model:** the guest, in sealed mode with the embedder's `links` grant, in an intact view.
- **Scenario:**
  1. The app shows a text field, or anything else that takes the keyboard, beside one or more marked links (an
     editor, a chat box).
  2. After the user's first click in the view, the guest calls `sandboxView.set('a', { focus: true })` on a marked link:
     the view focuses any HTML element while its document has focus.
  3. The user holds a key that activates a link (Enter, held to add lines or by a slow release). On Firefox each
     auto-repeated keydown on a focused link is a trusted `click`, the view sends one `VIEW_LINK` per click, and each
     `window.open` is allowed: in Firefox every repeat is a new activation.
  4. The guest listens to `keydown` and moves the focus between marked links between repeats, so each repeat is a
     choice of its own: n links give log₂(n) bits per repeat, up to `dom.popup_maximum` (20) tabs.
- **Evidence (run):** [review-3/links-key-repeat.spec.ts](review-3/links-key-repeat.spec.ts), with the browsers set up
  as `test/e2e/links-popup-blocker.spec.ts` sets them up (blocker on, release values). Output:
  [p4-output.txt](review-3/p4-output.txt). One keydown and nine repeats, 5.5 s after the last click:
  Firefox 10 `window.open` calls and 10 tabs at the listed URL; Chromium 1 and 1. With two links and the guest moving the
  focus on each keydown it heard, Firefox opened `A` then nine `B`: the guest changed the URL in the middle of one key
  hold. That it changed only once at an 80 ms repeat is the view's event delivery, which I did not take apart; one
  change is enough to show the choice.
- **Effect:** a listed site's server receives more than the stated bound per user action: one choice per repeat, not
  per click. The tabs are a flood the embedder cannot stop. It reaches sealed mode with its own opt-in (`links`), so by
  the board's rule it counts. Medium: the data reaches only URLs the embedder listed, and only while a key is held.
- **Rung:** the bound is a check made by the browser (activation), and Firefox's check is per keydown, not per user
  gesture. Nothing of the library's counts it.
- **Direction:** by construction, the view decides what a request is. Either a click that follows a `repeat` keydown
  sends nothing (the view's capture listener sees `keydown.repeat`, a platform field the guest cannot set), or a marked
  link cannot be focused by the guest (`VIEW_SET` `focus` refused on a marked link), so keyboard activation needs the
  user's own focus; better both. Then a spec with the held key on Firefox, beside the existing Enter test.
- **Test gap:** `test/e2e/links-popup-blocker.spec.ts` tests one Enter press and no repeat.

### 2. The docs say Enter on a focused link is a click, not that the guest chooses the focus

- **Breaks:** I6's sentence and docs/API.md's "The click is the request" read as the user's action on a link. The
  repository's own spec ("Enter on the marked link the guest focused, long after any click, opens it: the key is the
  click", `test/e2e/links-popup-blocker.spec.ts`) shows the guest can move focus to a marked link at any time and that
  the next Enter the user presses, meant for anything, opens it.
- **Effect:** the moment of a request is any Enter while the view has focus. The time is already part of the stated
  signal, so this is the wording, not a new channel. Low.
- **Direction:** say it in docs/API.md's `links` section and in 02, or remove the case (finding 1's second direction).

### 3. The write-time quota admits a write that no commit can ever take

- **Breaks:** `src/lib/guest-writes.ts`'s comment: "So a write the host could never register is refused at once with
  the store's own code, and a commit can still be refused (FILES_QUOTA_EXCEEDED) if the host registered more in
  between". The write-time check counts files and registered bytes; the commit adds what module and stylesheet rewrites
  add. Since step 1.5 the store changes only by commits, so "the host registered more" cannot happen either.
- **Evidence (run):** [review-3/i4-commit-attacks.test.ts](review-3/i4-commit-attacks.test.ts), the last case: a
  1.3 MB stylesheet of `url(a)` references is answered `ok` to the guest and listed. Its every commit throws
  `FILES_QUOTA_EXCEEDED`, since each reference is charged about 73 bytes at the commit. The refusal changes nothing (the
  all-or-none rule holds, and the other value of the list commits alone afterwards).
- **Effect:** an app is told its write stands when it never can, and an embedder that commits what it is shown gets a
  throw. No data effect. Low.
- **Direction:** the write-time check is the commit's check (the same `apply()` plan, rewrite costs included), or the
  comment and docs/API.md#guest-writes say what it leaves to the commit.

### 4. `GUEST_VALUES` files the guest's numbers and choices as the library's

- **Breaks:** I10's purpose, that an embedder can tell attacker data from the library's. `GUEST_VALUE_OWNERS.library`
  includes "a count", so `GuestWrite.size`, `GuestBytes.size` and `FileInfo.size` are the library's ("counted by the
  library"), although each is the length of bytes the guest chose, within the caps. In the same way `GuestWrite.change`,
  `SandboxLog.level`, `GuestWrite.type` (the guest picks the row by picking the path) and `FileInfo.type` (filed as the
  embedder's, which for a committed write it is not) are choices of the guest's within a closed set.
- **Evidence:** reading `src/lib/guest-values.ts`. Its `guest` owner is "the guest's, in whole or in part", which
  describes these values.
- **Effect:** a number an embedder uses as a length or an index is the guest's, bounded by the caps. No data effect
  found. Low.
- **Direction:** a fourth owner, or `guest` with a `bound` (a closed set, a cap), so that "the library chose it" and
  "the guest chose it within the library's bounds" read differently.

### 5. A resizable buffer measures its length, and its clone keeps its maximum

- **Class:** availability, kept apart by the board's rule unless the run below shows a host page that cannot regain
  control.
- **Read and run (Node, probe 5):** `createSizeOf()` counts an `ArrayBuffer`'s `byteLength`. A resizable buffer of 8
  bytes with a `maxByteLength` of 1 GiB measures 24 bytes, and Node's structured clone keeps the maximum.
- **Run (browsers, probe 6):** see [p6-output.txt](review-3/p6-output.txt) and the paragraph below.

On all three engines the clone that reaches the page keeps `resizable: true` and the maximum of 1 GiB. Chromium (the
headless shell) delivered 100 such buffers posted in one message from a worker, but one message of 1000 (24 000 bytes by
the measure, far under every budget) never arrived: neither `message` nor `messageerror` in 25 s. The page's own timer
went on ticking (500 ticks of 50 ms), so the page kept control. In a first run without that timer, the renderer's
virtual size grew to about 1.5 TiB of reservations and Playwright's `evaluate` never returned. Firefox delivered 1000.
WebKit refused to make more than about 60 in the worker (`RangeError: Out of memory`), which ends there.

- **Effect:** a guest's call or log line can be lost by the browser below the byte budget, and the host page's process
  reserves address space the measure does not see. The page went on running in every run where I measured it. So this
  is availability and correctness, bounded by the caps on calls in flight and by the guest's own worker. Low; backlogged
  by the board's rule. Not shown: a host page that never regains control.
- **Direction:** the measure counts `maxByteLength` for a resizable buffer, or refuses one (it is not a kind a guest
  needs to send: a fixed buffer carries the same bytes); `SNAPSHOT_REFUSED_KINDS` then names it.

## Invariant by invariant

| # | Result | What I tried |
| :--- | :--- | :--- |
| I1 | held (not re-attacked beyond step 2's changes) | `links` read by `start()`: a structured clone of the grants is read, so an entry's getter runs once, before validation |
| I2 | held | the same: `readLinks` validates every entry of the clone before anything is stored |
| I4 | held | (probe 3, run) the same value twice, two values of one entry; a `reset()` from a Proxy's `get` trap and from an `options.code` getter during the read; a list that grows while read; an `Array` subclass whose iterator yields an unminted value; a removal mark across `terminate()` and a write refused after it; a value of the previous environment beside a current one; a quota refusal (the pending list and the committed state unchanged, the other value then commits alone); copies, `structuredClone`, `JSON`, a `Proxy` of a value (the repository's tests) |
| I5 | held | `fileswritten`, `fileschanged`, `sandbox-log`, `violation` dispatched by `elementEvent`, which does not bubble |
| I6 | the URL held; the count per user action does not on Firefox (1); the moment is wider than worded (2) | the index (`listedLink`: non-integers, `-0`, out of range); a click on `meter`, `output`, `progress`, a label's forwarded click (the walk ends on the link or a stop; a click on a label's text sends nothing; the forwarded click reaches the link only as a covering link would); a marked link moved, re-rendered or restyled (a new element is a new mark; the href stays inert); a `VIEW_LINK` from a stale port (refused by port identity); list validation (`new URL(s).href === s` refuses default ports, uppercase schemes, IPv4 shorthands, tabs) |
| I7 | held | (probe 5, run) a `Blob` and a `File` alone, under an own `__proto__` key, in an array's non-index key, at index 100 000 of a sparse array, as a `Map` key and deep value, in a `Set`, behind a cycle, as an `Error`'s `cause`, in an `AggregateError`; every `postMessage` receiver on the host side read: the guest port (`PONG`, `LOG` through `toLogDetail`'s measure, `VIOLATION` normalised to strings and integers, `RESIZE` numbers, RPC frames measured whole on arrival), the view port (each field typed: `index` an integer, `height` a number, `message` a string, `dropped` a predicate), and the window listener (a table lookup) |
| I8 | held | `x.html.`, `x.png.` (no extension: `application/octet-stream`, needs `code`), `X.JS`, `a.html.png` (served `image/png`, an image load only), `..png`; the path rules admit ASCII only, so no look-alike or control character reaches a name |
| I9 | held | (probe 1, run) PNG, JPEG, GIF, WebP and AVIF signatures followed by an HTML and by an SVG document with a script: never a script, top-level (an image document of the signature's type), in an `<iframe>`, an `<object>` and an `<embed>`, on three engines; the same bytes typed `text/html` run (positive control). (Probe 2, run) 29 edge names on three engines: every non-inert name still ends `.download`; Firefox truncates a 265-character name to 254 characters and keeps `.download`; all three drop a leading dot (`..png` saves as `png`, `.htaccess.download` as `htaccess.download`); Chromium and WebKit turn `~` into `_` in some places |
| I10 | held as a check; classification nuance (4) | the registry against the declarations; termination reasons (a library table, an error's name checked against `^[A-Za-z][A-Za-z0-9]{0,63}$`) |
| I17 | held | not re-attacked: `links` is a grant only |

## Not covered

- Safari, where `.download` is also its own suffix for unfinished downloads (02 says so), and Safari's popup blocker with
  a held key.
- A desktop browser's download manager: probe 2 reads the name each engine hands its download manager
  (`suggestedFilename()`); Chromium's target determiner, which truncates and uniquifies, does not run headless.
- Touch activation, and Firefox's key repeat with other keys and with `accesskey`, which the renderer does not keep.
- The network build's modes beyond what `links` and `GUEST_VALUES` share with sealed mode.
- I1 to I3, I5 and I17 beyond what steps 2.1 to 2.6 changed: review 2 covered them.

## How to run the probes

From the checkout's root, with `PLAYWRIGHT_BROWSERS_PATH=/home/user/.cache/pw-project`:

| Probe | Command | Output |
| :--- | :--- | :--- |
| 1, I9 polyglots | `node docs/design/review-3/p1-image-polyglot.mjs` | [p1-output.txt](review-3/p1-output.txt) |
| 2, I9 names | `bun docs/design/review-3/p2-save-names.mjs`, then `bun docs/design/review-3/p2b-chromium-no-download.mjs` | [p2-output.txt](review-3/p2-output.txt), [p2b-output.txt](review-3/p2b-output.txt) |
| 3 and 5, I4 and I7 (unit) | `bunx vitest run -c docs/design/review-3/vitest.config.ts` | [p5-output.txt](review-3/p5-output.txt) |
| 4, I6 held key (e2e) | `flock /home/user/.cache/web-sandbox-e2e.lock bunx playwright test -c docs/design/review-3/playwright.config.ts --project=chromium --project=firefox --trace off --workers=1` | [p4-output.txt](review-3/p4-output.txt) |
| 6, resizable buffers | `node docs/design/review-3/p6-resizable-buffers.mjs` | [p6-output.txt](review-3/p6-output.txt) |
| the mutants | `python3 docs/design/review-3/mutate.py NAME FILE OLD NEW TEST...` | [mutations-output.txt](review-3/mutations-output.txt) |

In probe 2, Chromium dropped two of 29 downloads made in quick succession from one page (`.png.download`,
`x.exe~.download`); probe 2b downloaded both five times out of five, each in a fresh context. So the drops come from
the rate of downloads, which 02 already leaves to the browser, and not from the names.
