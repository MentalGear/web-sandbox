# Research 26: an interpreter logic tier, probed before building

**Question.** In sealed mode the content's logic runs as native JavaScript in a worker whose globals are cut down to an
allowlist ([ADR-008](../../ADR-008-sealed-mode.md), [`worker-globals.ts`](../../../src/lib/worker-globals.ts)). A design
review held that the stronger construction is a JavaScript interpreter compiled to WebAssembly (QuickJS class) inside
that worker: the content starts with no platform capability and gets exactly the functions the library hands it.
[ADR-001](../../ADR-001-continue-or-adopt.md) says a logic tier would adopt a QuickJS component; nothing of it was ever
measured. This note measures, on Chromium, Firefox and WebKit, whether such an interpreter loads under sealed mode's
policies, whether the host can still stop the content, what a memory cap does, what it costs, whether it moves research
19's rejection flood, what the content can reach, and what authors would lose. It measures; it decides nothing.

**Package.** [`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten) 0.32.0 (MIT): `quickjs-emscripten-core`
with the variant `@jitl/quickjs-wasmfile-release-sync` (Bellard's QuickJS 2025-09-13+f1139494 as a separate `.wasm`),
and `@jitl/quickjs-asmjs-mjs-release-sync`, the same interpreter compiled to pure JavaScript (asm.js), for the policy
question. Chosen over `quickjs-wasi` 3.7.0 (MIT, QuickJS-NG, the candidate ADR-001 names) because it is the one with a
pure-JavaScript build of the same interpreter (Q1 asks for it), it exposes the interrupt handler, the memory limit and
the stack limit separately, and it lets the worker hand it the `.wasm` bytes, a compiled module and a
`WebAssembly.Memory` of its own (needed for Q3). `quickjs-wasi`'s README states that its WASI build has no stack limit
(deep recursion traps the instance); it was not measured.

**Measured** 2026-11-14 on headless Playwright 1.58.1 (Chromium 145.0.7632.6 headless shell, Firefox 146.0.1, WebKit
26.0, Linux), a shared 4-core VM, one engine at a time under the shared browser lock. The load average is in every raw
line of [`results/`](results/) and in each table below. No library code runs: the probes build sealed mode's topology
with plain HTML, and read only `sealedViewPolicy`, `STRICT_WORKER_GLOBALS` and `test/e2e/host-share.ts` from the
repository.

## Answer in brief

- **Loading (Q1).** The WebAssembly build runs exactly when every policy in the list admits `'wasm-unsafe-eval'` (the
  host page's `script-src`, if it has one, and the view's sealed policy), on all three engines, as research 24 found for
  raw WebAssembly. Under sealed mode's policy as it is today (no keyword) it is refused everywhere (Chromium and Firefox
  at compile, WebKit at instantiation). **The asm.js build runs under every combination, the keyword absent everywhere
  included**: it is plain JavaScript.
- **Stopping (Q2), WebKit.** Content `for (;;) {}` inside the interpreter **is not stopped** by `Worker.terminate()` or by
  removing the frame on WebKit (a full core for the 9 s observed, two runs) unless the interpreter's interrupt handler is
  wired; wired (it calls a JavaScript function of the worker each time QuickJS polls), it stops within 0–300 ms. Single
  native operations inside the interpreter ran to their end before WebKit stopped: **the worst observed stop with the
  handler wired is 3.8 s after `terminate()`, set by `BigInt.prototype.toString` of the largest BigInt QuickJS allows**
  (4.2–4.3 s alone). Chromium stopped every case 1.9–2.0 s after `terminate()` (its forcible-termination delay, as in
  research 24); Firefox in the first 100 ms window.
- **The interpreter's own watchdog (Q2).** An interrupt handler that returns "stop" after a deadline needs no
  `terminate()` and works on all three engines, but it is only consulted once per 10 000 poll points: **about 5 000 turns
  of a loop that makes one native call per turn** (measured on all three). A single native operation delays it by its
  whole length (worst: 4.3 s Chromium and WebKit, `BigInt` `toString`; 14.3 s Firefox, `JSON.stringify` of 1 M objects).
  A loop of heavy operations delays it by about 5 000 × the operation: `for (;;) 'x'.repeat(2e8)` with a 1 s deadline had
  not returned after 60 s (Bun's JavaScriptCore; inferred to hold in the browsers from the measured 5 000 turns).
- **Memory (Q3).** The interpreter's limit and a maximum on the WebAssembly memory both end in a catchable
  `InternalError: out of memory` inside the content, on all three engines; the interpreter, a new context and a new
  instance stay usable; the host page's longest stall was 1–9 ms.
- **Cost (Q4).** 199 KB brotli for the `.wasm` plus 18 KB for the worker bundle (asm.js: 278 KB). Cold start 19–26 ms;
  a new instance from a compiled module 2–5 ms; a new context about 1 ms. The interpreter is 11–46× slower than the
  native worker on a computation loop, 4–22× on rendering markup, 7–57× on JSON round trips, and one "add a todo" turn of
  the example app takes 2.3–8.1 ms against 0.17–0.38 ms (7.7–21×). Firefox is the slowest engine for the interpreter.
- **Rejection flood (Q5), Firefox.** Inside the interpreter the flood cost the host page 0% (four runs); research 19's
  native flood kept it 96–98% busy. The native control could not be rerun here: it got the browser killed for lack of
  memory in both attempts.
- **Reach (Q6).** Inside the interpreter the global object has 73 names, all ECMAScript; no `navigator`, `fetch`,
  `postMessage`, timers, `console`, `performance` or module loading. `eval` and `Function` work inside it and raised no
  violation event and no report on the host page, while native `eval` did (the positive control). New: a 1 ms
  `Date.now()` and `Math.random()` are there with no host function.
- **Authors (Q7).** Of the 219 names on sealed mode's worker allowlist, the interpreter has 61 (the language); the other
  158 are absent, `Intl`, timers, `TextEncoder`, `structuredClone`, `crypto`, `URL`, `Blob` and `OffscreenCanvas` among
  them, and would have to be supplied as host functions.

## Method

- **Topology** (as research 20 and 24): a real `node:http` server on loopback ([`server.mjs`](server.mjs)) serves the host
  page with its policy as a response header; the host page makes an `iframe[sandbox="allow-scripts"]` whose `srcdoc`
  carries `sealedViewPolicy` (read from [`csp-generator.ts`](../../../src/lib/csp/csp-generator.ts)) as a `<meta>`,
  admitting one inline script by its hash; that script makes a `blob:` worker from the source the host page posts it,
  and the host page posts the `.wasm` bytes, which the worker hands to the interpreter (no request is made from the view
  or the worker: `connect-src 'none'`). Where the WebAssembly build runs, the view's policy is `sealedViewPolicy` with
  `'wasm-unsafe-eval'` added to `script-src` (research 24's opt-in); the asm.js build runs under the policy as it is.
- **The worker** ([`worker-runtime.mjs`](worker-runtime.mjs)) is the probe's own (it keeps its `postMessage` to report),
  bundled with a variant by [`build.mjs`](build.mjs) into one classic script. Every content string is evaluated inside
  the interpreter. Memory limit 256 MiB and stack limit 1 MiB unless a question says otherwise.
- **Stopping** ([`q2-stop.mjs`](q2-stop.mjs)): research 24's method. The browser is launched as a server so its process
  id is known; the CPU of its whole process tree is read from `/proc` in 100 ms windows ("1.0" is one core). The content
  loops; the view calls `Worker.terminate()`; 6 s later the frame is removed and 3 s more are read (or the frame alone is
  removed and 9 s read). "Stopped at" is the first window after which no window reaches 0.85 cores (the loop shows
  0.9–1.4 per window; Firefox's own background work makes single windows of up to 0.8). Content forms: **repeat**, the
  operation in an endless loop; **once**, the operation once, then `for (;;) {}`. "Wired": the interrupt handler is
  installed and returns false (each poll is a call from the WebAssembly into a JavaScript function of the worker);
  "unwired": no handler. The watchdog part measures, in the worker, each operation's duration (3 runs) and the time from
  a deadline that has already passed to the interpreter's return (3 runs).
- **The busy share** (Q5) and the host page's longest stall (Q3) go through [`host-share.ts`](../../../test/e2e/host-share.ts)
  (best of N windows against the page's own idle baseline; its stall meter).
- **Cost** ([`q4-cost.mjs`](q4-cost.mjs)): 5 runs per engine and build, each a fresh page and worker, each started when
  the 1-minute load average was under 2. Speed: the same function source natively in the worker and inside the
  interpreter ([`lib.mjs`](lib.mjs), `BENCH`); the app: [`examples/sealed-app/app.js`](../../../examples/sealed-app/app.js)
  unchanged, with `sandboxView`, `bridge` and `sandboxFiles` stubbed alike on both sides (the stubs count what they are
  given) and, inside the interpreter, an `OffscreenCanvas` shim whose calls go to a real `OffscreenCanvas` in the worker;
  100 turns of "submit a todo" after loading 100, timed as a series (one turn is under the 1 ms clock step of Firefox's
  and WebKit's workers). Both sides did the same work (the stubs' totals are equal in every run).
- Each script prints one tagged JSON line per result; [`run.mjs`](run.mjs) runs one probe on one engine under the lock and
  writes [`results/`](results/README.md); [`summarize.mjs`](summarize.mjs) prints the figures below from them.

## Q1. Loading under sealed mode's policies

`runs` = the module instantiated and the interpreter evaluated `6 * 7` to 42. Host policies: (a) none; (b) `script-src
'self' <view hash>; worker-src blob:`; (c) the same with `'wasm-unsafe-eval'`. ([results/q1-*.txt](results/))

| Build | View policy | Host (a) none | Host (b) no keyword | Host (c) keyword |
| :--- | :--- | :--- | :--- | :--- |
| WebAssembly | sealed (today) | refused C F W | refused C F W | refused C F W |
| WebAssembly | sealed + `'wasm-unsafe-eval'` | **runs** C F W | refused C F W | **runs** C F W |
| asm.js | sealed (today) | **runs** C F W | **runs** C F W | **runs** C F W |
| asm.js | sealed + `'wasm-unsafe-eval'` | runs C F W | runs C F W | runs C F W |

- The refusals: Chromium `CompileError: WebAssembly.instantiate(): Compiling or instantiating WebAssembly module violates
  …`, Firefox `call to WebAssembly.instantiate() blocked by CSP`, WebKit `Refused to create a WebAssembly object because
  'unsafe-eval' or 'wasm-unsafe-eval' is not an allowed source of script`. The Emscripten glue turns each into
  `RuntimeError: Aborted(…)`: the interpreter never starts, so a build would end with a reason, not degrade.
- Chromium and Firefox raise a `script-src wasm-eval` violation event in the worker; WebKit raises none (as research 24
  found for every worker report on WebKit).
- The asm.js build needs no policy keyword at all on any engine (measured under (b) with the sealed view policy).
- Time to a ready interpreter in this probe: 13–16 ms (WebAssembly, Chromium), 27–41 ms (asm.js); Q4 has the medians.

## Q2. Stopping

### Termination: `Worker.terminate()` and frame removal

Time from `terminate()` (or from the removal) until the tree stopped, 100 ms windows; "never" = a core stayed busy for
all 6 s, and for the 3 s after the frame was then removed. Load average 0.2–1.8 at the start of each case.
([results/q2-*-cpu*.txt](results/))

| Content (form, handler) | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| `for (;;) {}`, unwired, `terminate()` | 1.9 s | at once | **never** (2 runs) |
| `for (;;) {}`, unwired, frame removed | 1.9 s | at once | **never** (2 runs) |
| `for (;;) {}`, wired, `terminate()` / frame removed | 1.9 s / 1.9 s | at once / at once | **0–0.2 s / 0.1–0.3 s** |
| catastrophic regex, repeat, unwired / wired | – | – | **never** / 0.1 s |
| `Float64Array` sort (10 M), once, unwired / wired | – | – | **never** / 1.4 s |
| `JSON.stringify` (1 M objects), once, unwired / wired | – | – | 0.2 s / 0.4 s |
| `'x'.repeat(2e8)`, once, unwired / wired | – | – | 0.1 s / 0.1 s |
| `BigInt` `toString` (1 048 000 bits), once, unwired / wired | 1.9 s / 1.9 s | at once / at once | 3.9 s / **3.8 s** |
| `Float64Array` sort, repeat (a copy each turn), wired | – | – | 1.3 s |
| `BigInt` `toString`, repeat, wired | 1.9 s | at once | 3.8 s |
| in-place `reverse(); sort()`, repeat, unwired / wired | 2.0 s / 1.9 s | at once / at once | 1.3 s / 1.4 s |

- **WebKit does not stop the interpreter's own bytecode loop** (`for (;;) {}` runs inside one C function of the
  interpreter, with no call out of the WebAssembly). This is research 24's residual, for the interpreter. Wiring the
  interrupt handler turns it into a loop that calls a JavaScript function every poll, and WebKit then stops it within
  0–300 ms, as research 24 found for a WebAssembly loop that calls an import.
- **With the handler wired, every case stopped on WebKit, at the latest at the end of the native operation that was
  running**: 1.3–1.4 s for the sorts (the rest of a 1.8–1.9 s operation), 3.8 s for `BigInt` `toString` (a 4.2–4.3 s
  operation). Unwired, the "once" cases that end in `for (;;) {}` never stopped (sort), except where WebKit stopped
  earlier (below).
- **What WebKit stops at is not only a call to a JavaScript import.** [`import-calls.mjs`](import-calls.mjs) counted the
  calls into the glue's JavaScript functions during each operation (Bun, JavaScriptCore;
  [results](results/import-calls-bun.txt)): `JSON.stringify` and `'x'.repeat` call the memory-growth import on their first
  turn (which matches WebKit stopping them at 0.1–0.4 s unwired); `BigInt` `toString` and the in-place sort make **no**
  import call, yet WebKit stopped them at 3.9 s and 1.3 s unwired. The mechanism was not determined. What held in every
  run: an unwired `for (;;) {}` never stopped, and a wired one stopped at once.
- Chromium's 1.9–2.0 s is the same in every case, wired or not, the JavaScript loop of research 24 included; it is not
  new. After the page was closed the tree was idle in every case on every engine.

### The interpreter's interrupt as a watchdog (no `terminate()`)

Duration of each operation alone, and the time from a deadline that had already passed to the interpreter's return
(`InternalError: interrupted`); median of 3 (range), ms. After each, the interpreter evaluated `1 + 1` again.
([results/q2-*-watchdog.txt](results/)) Load average: Chromium 0.8–1.3, Firefox 1.0–1.3, WebKit 1.5–2.4 (above 2 only for the empty loop and the regex; 1.5 for the `BigInt` row).

| Operation (inside the interpreter) | Chromium: alone / watchdog | Firefox: alone / watchdog | WebKit: alone / watchdog |
| :--- | :--- | :--- | :--- |
| `for (;;) {}` | – / 0.5 (0.2–6.9) | – / 1 (1–2) | – / 1 (1–2) |
| `/^(a+)+$/.test('a'×40 + 'b')` | – / 3.1 (0.6–3.7) | – / 2 (1–2) | – / 1 (1–4) |
| `Array` sort, 3 M numbers (a copy) | 3 140 (3 096–3 636) / 3 100 | 10 560 (10 215–10 613) / 10 321 | 2 737 (2 708–2 780) / 2 716 |
| `Float64Array` sort, 10 M (a copy) | 2 168 (2 064–3 652) / 2 061 | 6 213 (6 199–6 530) / 6 092 | 1 907 (1 841–1 919) / 1 835 |
| `JSON.stringify`, 1 M objects (42 MB) | 2 084 (1 920–2 127) / 2 028 | **14 264 (14 176–14 355) / 14 180** | 1 879 (1 786–2 084) / 1 728 |
| `JSON.parse` of the same | 1 403 (1 375–1 496) / 1 369 | 12 080 (11 849–12 118) / 11 955 | 1 662 (1 655–1 687) / 1 641 |
| `'x'.repeat(2e8)` | 603 (563–771) / 624 | 3 000 (2 983–3 141) / 3 086 | 660 (650–688) / 619 |
| `Array(2e7).fill('ab').join(',')` | 469 (393–515) / 414 | 2 596 (2 572–2 775) / 2 680 | 336 (333–339) / 347 |
| `BigInt` `toString`, 1 048 000 bits | **4 294 (4 273–4 299) / 4 251** | 8 385 (8 267–8 459) / 8 605 | **4 239 (4 237–4 287) / 4 268** |
| turns of `for (;;) { n++; 'x'.repeat(1000) }` between two polls | 5 000 | 5 000 | 5 000 |

- **The watchdog's latency is the rest of the native operation that is running**, on every engine, and control comes
  back with a catchable `InternalError: interrupted`; the interpreter stays usable. A loop of nothing and the regex
  engine poll often (1–7 ms).
- **QuickJS polls once per 10 000 poll points**, about 5 000 turns of a loop that makes one native call per turn (the
  constant `JS_INTERRUPT_COUNTER_INIT` is compiled in; the package has no setting for it). So a loop of heavy native
  operations delays both the watchdog and, on WebKit, a wired `terminate()` by up to about 5 000 operations: with a 1 s
  deadline, `for (;;) 'x'.repeat(2e8)` had not returned after 60 s ([poll-gap.mjs](poll-gap.mjs),
  [results](results/poll-gap-bun.txt), Bun; in the browsers the first version of the watchdog probe, which used that
  form, hit its 180 s timeout for six operations on WebKit; that output was replaced by the version above and is not
  kept). In the WebKit termination runs above, the two "repeat" cases with heavy operations stopped after one operation
  all the same; why WebKit stopped there is the undetermined mechanism above.
- **What bounds a single operation.** The sorts, `JSON` and `repeat`/`join` scale with the data, which the memory limit
  bounds (256 MiB here). `BigInt` `toString` needs 130 KB: QuickJS's own maximum BigInt size (about 2²⁰ bits, compiled
  in) bounds it, not the memory limit. The catastrophic regex and the empty loop poll and are bounded by the watchdog.
  Firefox ran every heavy operation 3–7× slower than the other two, so the same content's worst operation is 14.3 s
  there against 4.3 s.

**Worst stopping bound observed:** on WebKit with the handler wired, 3.8 s after `terminate()` (the rest of a 4.2–4.3 s
`BigInt` `toString`); for the watchdog, 14.3 s on Firefox (`JSON.stringify` of 1 M objects under a 256 MiB limit).
Unwired on WebKit: unbounded (`for (;;) {}`). A loop of heavy operations: about 5 000 × the operation (inferred from
the measured poll gap; not observed to its end).

## Q3. Memory

The content allocates in a loop: `arrays` (arrays of 10⁵ numbers, kept), `string` (`'x'.repeat(n)` with `n` doubling, kept), each inside
`try`/`catch`; `uncaught` the same without `try`. Limits: the interpreter's (`setMemoryLimit`) and a maximum on the
`WebAssembly.Memory` the worker passes the glue. ([results/q3-*.txt](results/))

| Limits | Content | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- | :--- |
| interpreter 64 MiB | arrays | caught `InternalError: out of memory`, 3.1 s | the same, 15.2 s | the same, 3.2 s |
| interpreter 64 MiB | string | caught, 0.4 s | caught, 2.1 s | caught, 0.4 s |
| interpreter 64 MiB | uncaught | the evaluation returns the error, 3.0 s | 12.5 s | 2.9 s |
| WebAssembly memory max 64 MiB, no interpreter limit | arrays / string | caught, 0.16 s / 0.12 s (memory 63.4 / 34.8 MiB) | caught, 0.5 s / 0.5 s | caught, 0.15 s / 0.12 s |
| interpreter 64 MiB, memory max 128 MiB | arrays | caught at 125.6 MiB of memory, 0.2 s | caught, 0.9 s | caught, 0.2 s |
| none (the glue's own maximum) | arrays | caught, 3.0 s | caught, 16.3 s | caught, 3.3 s |
| **After each:** the same context, a new context, a new instance | | all usable | all usable | all usable |
| **Host page:** longest stall during the run (in brackets: a control run that allocates nothing) | | 1–4 ms (2) | 2–7 ms (3) | 4–9 ms (5) |

- A full WebAssembly memory makes `malloc` fail, and QuickJS reports that as the same catchable error as its own limit;
  no case aborted the instance or the worker. With both limits, the WebAssembly maximum was reached first (125.6 MiB of
  128 against a 64 MiB interpreter limit: the limit counts the interpreter's allocations, not the allocator's overhead).
- With no limit the content filled the glue's default maximum (inferred: 2 GiB, the glue's `maximum: 32768` pages; the
  memory's size was not read in that case) and still got a catchable error. On Firefox and WebKit the worker lives in
  the host page's process (research 24), so that 2 GiB is the host's.

## Q4. Cost

### Size ([results/sizes.json](results/sizes.json))

| File | Raw | gzip -9 | brotli -q 11 |
| :--- | ---: | ---: | ---: |
| `quickjs.wasm` (the interpreter) | 503 134 | 232 036 | 199 016 |
| worker bundle, minified (Emscripten glue, the package's FFI, `quickjs-emscripten-core`, and this probe's worker code) | 67 000 | 19 986 | 17 878 |
| asm.js worker bundle, minified (the interpreter as JavaScript, glue, FFI, core, probe) | 1 052 434 | 338 684 | 277 545 |

### Startup and speed

Median (range) of 5 runs, ms; ratio = interpreter ÷ native, per run. Load average at the start of each run 1.6–2.2.
([results/q4-*.txt](results/))

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| a native worker's first message | 6.8 (5.1–7.3) | 15 (10–17) | 7 (4–12) |
| the WebAssembly bundle's first message | 10.9 (8.1–11.7) | 23 (16–24) | 10 (7–16) |
| cold: bytes → compiled, instantiated, a context evaluated `1` | 18.9 (14.2–21.5) | 26 (19–39) | 25 (22–28) |
| compile alone | 2.8 (2.2–3.8) | 19 (13–41) | 8 (6–19) |
| warm: a new instance from the compiled module | 1.8 (1.3–1.9) | 3 (3–4) | 5 (3–10) |
| a new context in a live runtime | 0.7 (0.4–1.1) | 1 (1–2) | 1 (1–1) |
| loop (3 M iterations): native / interpreter | 48.5 / 628 → **12.9×** (12.2–13.4) | 53 / 2 352 → **46×** (40–47) | 53 / 602 → **11.2×** (9.0–12.2) |
| render 1 000 items × 100: native / interpreter | 16.5 / 81.5 → **5.1×** (4.7–6.2) | 24 / 539 → **22×** (22–27) | 33 / 143 → **4.5×** (3.8–5.6) |
| JSON round trip, 1 000 todos × 100 | 15.2 / 179 → **11.9×** (10.1–12.2) | 25 / 1 399 → **57×** (50–58) | 36 / 234 → **6.9×** (6.2–8.4) |
| one "add a todo" turn of the app: native / interpreter | 0.37 / 2.6 → **7.7×** (5.0–8.4) | 0.38 / 8.1 → **21×** (19–26) | 0.17 / 2.3 → **13.9×** (13.4–16.9) |
| asm.js build: cold start | 34.6 (32.9–44) | 56 (48–65) | 50 (48–67) |
| asm.js build: loop / render / JSON / turn ratio | 225× / 44× / 39× / 20× | 33× / 19× / 31× / 20× | 96× / 16× / 22× / 28× |

- A turn of the app inside the interpreter crosses the boundary about a hundred times (a `text()` per todo, the canvas
  calls, the promises the host resolves); its cost is that crossing as much as the interpretation.
- Firefox runs this WebAssembly build slower than its asm.js build in the loop (46× against 33×); not investigated.

## Q5. Research 19's rejection flood, inside the interpreter (Firefox)

Two unhandled rejections with a 16 Mi-character `Error` as the reason on every tick of the worker's 0 ms interval, which
evaluates `tick()` in the interpreter and runs its pending jobs. `interp` shares one string (research 19's shape);
`interp-fresh` makes a new one per rejection. Host page busy share through `host-share.ts`, two runs.
([results/q5-firefox-interp-interp-fresh.txt](results/q5-firefox-interp-interp-fresh.txt))

| Flood | Firefox: busy share, best window (mean) | Ticks in its first 3 s |
| :--- | :--- | :--- |
| inside the interpreter, `interp` | **0% (0%), 0% (0%)** | 705, 705 |
| inside the interpreter, `interp-fresh` | **−1% (0%), 0% (0%)** | 6, 6 |
| natively in the worker (research 19's flood, the control) | not measured here: in both attempts the browser was killed for lack of memory during the flood; research 19 measured 96–98% | – |

- An unhandled rejection inside the interpreter is a value of the interpreter: nothing reaches the worker's
  `unhandledrejection` path, the view or the host page (the package installs no rejection tracker). The cost stays on
  the worker's thread. Load average 2.0–3.0 during these runs.

## Q6. What the content can reach

Host page policy `script-src 'self' <view hash> 'wasm-unsafe-eval' 'report-sample'; worker-src blob:; report-uri
/__report`; no host function installed in the interpreter. ([results/q6-*.txt](results/))

| | Chromium | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| the interpreter's global object (with its prototype chain) | 73 names | 73 | 73 |
| `navigator`, `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `postMessage`, `self`, `location`, timers, `queueMicrotask`, `console`, `performance`, `crypto`, `Worker`, `indexedDB`, `caches`, `BroadcastChannel`, `MessageChannel`, `WebAssembly`, `Atomics` | all `undefined` | all `undefined` | all `undefined` |
| `Function('return this')().navigator`; `(() => {}).constructor('return typeof navigator + typeof fetch + typeof postMessage')()` | `undefined`; `undefinedundefinedundefined` | the same | the same |
| `import('https://…')` / a static `import` | rejected / `ReferenceError: could not load module` | the same | the same |
| `eval('1 + 1')`, `new Function('return 3')()` inside the interpreter | 2, 3 | 2, 3 | 2, 3 |
| violation events (worker, view, host page) and reports during all of the above | none, none | none, none | none, none |
| control: native `eval` in the worker and in the view | refused; 2 events in the worker, 2 in the view; 2 reports | refused; 2 + 2 events; 2 reports | refused; 0 events in the worker, 1 in the view; 1 report |
| `Date.now()` smallest step / `Math.random()` | 1 ms / present | 1 ms / present | 1 ms / present |

- **Verified:** with no host function installed, the content reached no platform object, no network or module loader and
  no channel out of the interpreter by any of these routes, and its `eval`/`Function` ran inside the interpreter without
  the browser seeing a string compiled (no event, no report), while the same page reported native `eval` (Chromium,
  Firefox: worker and view; WebKit: view only, as it raises no worker reports).
- **Not verified:** that no other route exists. The 73 names are the language's own (`SharedArrayBuffer` among them, a
  plain buffer inside the interpreter: there is no second thread). `Date.now()` (a 1 ms clock) and `Math.random()` come
  through the glue with no host function; a logic tier that wants no clock must remove `Date` or replace the glue's
  import.
- **The boundary** (`boundary` job; the host function takes what the content passes, `quickjs-emscripten`'s
  `getString`/`dump`):

  | Content passes | Chromium | Firefox | WebKit | What crossed |
  | :--- | :--- | :--- | :--- | :--- |
  | `'x'.repeat(1e8)` | 285 ms | 956 ms | 375 ms | a 100 M-character copy (UTF-8 out of the WebAssembly memory, decoded again) |
  | `'é'.repeat(5e7)` | 435 ms | 994 ms | 539 ms | the same, 50 M characters |
  | a cyclic object | 2 ms | 0 ms | 1 ms | the string `"[object Object]"`, no error |
  | an object with two getters | 0.3 ms | 0 ms | 1 ms | `{"a":1,"b":2}`: **the getters ran** (2 side effects in the content) |
  | a `Proxy` | 0.4 ms | 1 ms | 1 ms | `{"a":1}`: **9 traps ran** in the content |
  | `toJSON` returning 50 M characters | 1 011 ms | 5 562 ms | 1 326 ms | the 50 M-character string |
  | a getter that loops for ever | 999 ms | 1 001 ms | 1 000 ms | `"[object Object]"` after the watchdog (1 s) interrupted the getter |

  Marshalling runs content code inside the host function (getters, traps, `toJSON`): without an interrupt handler, the
  looping getter would have held the host function, and the worker, for ever. A cyclic value comes back as a string,
  silently. Size is unbounded unless the host function checks it before converting. A `BigInt` larger than the host
  engine allows threw in the host (WebKit: `RangeError: Out of memory: BigInt generated from this operation is too big`,
  when the probe let a 1 048 000-bit BigInt cross by mistake).

## Q7. What authors would lose

Measured: each name of sealed mode's worker allowlist (`STRICT_WORKER_GLOBALS` without `WebAssembly`, 219 names) looked
up on the interpreter's global object, the same on all three engines.

- **Present (61), the language:** `globalThis`, `Infinity`, `NaN`, `undefined`, `eval`, `isFinite`, `isNaN`, `parseFloat`,
  `parseInt`, the URI functions, `escape`, `unescape`, `Object`, `Function`, `Array`, `Number`, `Boolean`, `String`,
  `Symbol`, `BigInt`, `Date`, `RegExp`, `Promise`, `Proxy`, `Reflect`, `JSON`, `Math`, `Iterator`, the eight error
  constructors and `InternalError`, `ArrayBuffer`, `SharedArrayBuffer`, `DataView`, the eleven typed arrays (with
  `Float16Array`), `Map`, `Set`, `WeakMap`, `WeakSet`, `WeakRef`, `FinalizationRegistry`.
- **Absent (158), each a host function the library would have to supply, or a loss:**
  - of the language: `Intl`, `Atomics`, `Temporal`, `SuppressedError`, `DisposableStack`, `AsyncDisposableStack`
    (`toLocaleString` and friends without `Intl` are QuickJS's own minimal ones);
  - the worker's scope: `self`, `location`, `navigator`, `origin`, `isSecureContext`, `crossOriginIsolated`, `name`,
    `close`, the `on…` handlers, **`setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `queueMicrotask`,
    `requestAnimationFrame`, `cancelAnimationFrame`**, **`structuredClone`**, `reportError`, `atob`, `btoa`, **`console`**,
    **`performance`**, **`crypto`** (`getRandomValues`), `indexedDB`, `createImageBitmap`, `scheduler`, the scope
    interfaces;
  - requests (sealed refuses them anyway): `fetch`, `XMLHttpRequest` and its two interfaces, `WebSocket`;
  - values and events: `Request`, `Response`, `Headers`, `FormData`, `AbortController`, `AbortSignal`, `Event`,
    `EventTarget`, `CustomEvent` and the other event interfaces, `DOMException`, `QuotaExceededError`, `DOMStringList`,
    `MessageChannel`, `MessagePort`, `BroadcastChannel`;
  - bytes, text, streams, URLs: `Blob`, `File`, `FileList`, `FileReader`, `FileReaderSync`, **`URL`**,
    **`URLSearchParams`**, `URLPattern`, **`TextEncoder`**, **`TextDecoder`** and their streams, `CompressionStream`,
    `DecompressionStream`, every `ReadableStream`/`WritableStream`/`TransformStream` interface, the queuing strategies,
    `Crypto`;
  - IndexedDB's interfaces, `MediaCapabilities`, `Scheduler`, `TaskController`, `TaskSignal`, `TaskPriorityChangeEvent`,
    the eight `Performance…` interfaces;
  - geometry, images, canvas, WebGL: the `DOMMatrix`/`DOMPoint`/`DOMQuad`/`DOMRect` families, `ImageData`,
    `ImageBitmap`, `ImageBitmapRenderingContext`, **`OffscreenCanvas`**, `OffscreenCanvasRenderingContext2D`,
    `CanvasGradient`, `CanvasPattern`, `Path2D`, `TextMetrics`, the 18 `WebGL…` interfaces;
  - WebCodecs: `AudioData`, `EncodedAudioChunk`, `EncodedVideoChunk`, `VideoColorSpace`, `VideoFrame`.
- **What the example app needed** (measured by running it, Q4): `sandboxView`, `bridge` and `sandboxFiles` (the
  library's API, supplied in both designs) and `OffscreenCanvas` with `getContext('2d')`, `fillStyle`, `fillRect` and
  `convertToBlob`, which the probe supplied as a shim over host functions; its async functions also need the host to run
  the interpreter's pending jobs after every host promise it settles.
- Also changed: inside the interpreter `eval` and `Function` work (sealed mode's native worker refuses them by policy), and
  the language is QuickJS's (2025-09-13), not the engine's.

## What this means for the decision

Facts that favour an interpreter tier:
- The content starts with 73 ECMAScript names and nothing of the platform, by construction; nothing reached the platform
  by any route tried, and its string evaluation is invisible to the page's policy (Q6).
- The asm.js build loads under sealed mode's policy as it is, with no keyword, on all three engines (Q1).
- Wired, the interrupt handler makes WebKit stop the content's own loops (0–0.3 s), and the interpreter's watchdog stops
  content with no `terminate()` on every engine (Q2).
- Memory limits end in a catchable error, the interpreter survives, the host page stalls 1–9 ms (Q3).
- Research 19's rejection flood cost Firefox's host page 0% inside the interpreter (Q5).
- Startup is 19–26 ms cold and about 1 ms per new context (Q4).

Facts that count against:
- On WebKit the stop is bounded by the native operation that is running: 3.8 s observed with the handler wired
  (`BigInt` `toString`), and by about 5 000 such operations for the watchdog and, on WebKit, for `terminate()` (QuickJS's
  compiled-in poll gap; inferred); without the handler, never (Q2). Neither bound is set by a library constant.
- The WebAssembly build needs `'wasm-unsafe-eval'` in the view's policy and in the host page's `script-src`; only the
  asm.js build avoids it, at 16–225× the native time (Q1, Q4).
- The content runs 4–57× slower (WebAssembly build), Firefox the slowest by far; a single heavy operation takes 3–7×
  longer on Firefox than elsewhere, which also lengthens its watchdog bound to 14.3 s (Q2, Q4).
- 199–278 KB brotli more to ship (Q4).
- 158 of the allowlist's 219 names are gone, timers, `Intl`, `TextEncoder`, `URL`, `crypto` and `OffscreenCanvas` among
  them; each one supplied is a host function on a new boundary where marshalling runs content code (getters, traps,
  `toJSON`), copies unbounded strings and turns cycles into `"[object Object]"` (Q6, Q7).
- A 1 ms clock and `Math.random()` come with the glue, not from the library (Q6).

## Not measured

- **Safari on macOS and iOS**, and Firefox with site isolation (Fission) on: only Playwright's Linux builds were run.
- **Research 19's native rejection flood as a same-run control on Firefox:** the browser was killed for lack of memory in
  both attempts (the session shares one memory limit); research 19's 96–98% is the comparison. Q5 on Chromium and WebKit
  was not run (budget; Firefox was the engine with the cost).
- **Why WebKit stopped `BigInt` `toString` and the in-place sort without any import call** (Q2): not determined.
- **A loop of heavy native operations observed to its end** in a browser (5 000 × the operation): inferred from the
  measured poll gap and the 60 s Bun run; WebKit's two "repeat" runs stopped after one operation.
- **The host page's own thread during a long single operation** on Firefox and WebKit (the worker is in the host page's
  process there, research 24): the busy share was measured only for the flood.
- `quickjs-wasi` and the quickjs-ng variant of `quickjs-emscripten`: installed, not measured.
- The memory size reached with no limit at all (Q3): the glue's 2 GiB maximum is inferred.
- The library itself: no code of it was built on an interpreter; the probe's worker is its own.

## Rerun

The packages go into a scratch directory, never into the repository's `package.json`:

```sh
export INTERP_DIR=/path/to/scratch/interp PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers
mkdir -p $INTERP_DIR && cd $INTERP_DIR && echo '{"private":true}' > package.json
bun add quickjs-emscripten-core@0.32.0 @jitl/quickjs-wasmfile-release-sync@0.32.0 @jitl/quickjs-asmjs-mjs-release-sync@0.32.0
cd -   # the repository root, with `bun install` done (for playwright)
bun docs/research/26_interpreter_logic_tier/build.mjs            # INTERP_DIR/build/, and the sizes
# one probe, one engine, under the shared lock (WEB_SANDBOX_LOCK overrides its path); writes results/
bun docs/research/26_interpreter_logic_tier/run.mjs q1 webkit
bun docs/research/26_interpreter_logic_tier/run.mjs q2 webkit watchdog
bun docs/research/26_interpreter_logic_tier/run.mjs q2 webkit cpu                                   # loop, regex, sorts, stringify, repeat, BigInt
bun docs/research/26_interpreter_logic_tier/run.mjs q2 chromium cpu loop bigintToString sortInPlace
bun docs/research/26_interpreter_logic_tier/run.mjs q3 firefox
bun docs/research/26_interpreter_logic_tier/run.mjs q4 chromium          # 5 runs; waits for a load average under 2
bun docs/research/26_interpreter_logic_tier/run.mjs q5 firefox 2 interp interp-fresh   # add `native` for the control
bun docs/research/26_interpreter_logic_tier/run.mjs q6 webkit
bun docs/research/26_interpreter_logic_tier/summarize.mjs q2            # the tables' figures
# the two side measurements in Bun (they resolve the packages from their own directory)
cp docs/research/26_interpreter_logic_tier/{import-calls,poll-gap}.mjs $INTERP_DIR/
bun $INTERP_DIR/import-calls.mjs '{"sortInPlace":["globalThis.g = new Float64Array(1e7); for (let i = 0; i < g.length; i++) g[i] = (i * 7919) % 1000003","g.reverse(); g.sort()"],"bigintToString":["globalThis.x = (1n << 1048000n) - 1n","x.toString().length"],"repeat":["","\"x\".repeat(2e8).length"]}'
timeout 60 bun $INTERP_DIR/poll-gap.mjs; echo exit $?
```

A machine with proxy variables set can fail WebKit's page loads; `lib.mjs` leaves them out of the browser's environment.
The scripts are `.mjs`, not specs: the repository's Playwright configuration does not run them.

Files: [`server.mjs`](server.mjs), [`lib.mjs`](lib.mjs), [`worker-runtime.mjs`](worker-runtime.mjs), [`build.mjs`](build.mjs),
[`q1-policy.mjs`](q1-policy.mjs), [`q2-stop.mjs`](q2-stop.mjs), [`q3-memory.mjs`](q3-memory.mjs), [`q4-cost.mjs`](q4-cost.mjs),
[`q5-flood.mjs`](q5-flood.mjs), [`q6-reach.mjs`](q6-reach.mjs), [`import-calls.mjs`](import-calls.mjs),
[`poll-gap.mjs`](poll-gap.mjs), [`run.mjs`](run.mjs), [`summarize.mjs`](summarize.mjs), [`results/`](results/).
