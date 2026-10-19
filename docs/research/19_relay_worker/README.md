# Research 19: a trusted relay worker, probed before building

**Question (backlog S66; [research 18](../18_finding_classes/README.md), design 7).** In strict mode the view spawns
the guest's worker, so the worker's error events and messages land on the view's thread, which is the host page's
thread in Firefox, WebKit and Chromium's headless shell. Should the view instead spawn a library-only relay worker that
spawns the guest as a nested worker, holds its only port, and measures what it sends in a trusted realm?

**Measured on headless Playwright 1.58.1 on a 4-core VM** (Chromium 145.0.7632.6 as the headless shell and as the full
build with `channel: 'chromium'`, Firefox 146.0.1, WebKit 26.0), 2026-10-18 and 19, from `7b13007`. The numbers are this
machine's. The decisions rest on their shapes: which thread pays, and what changes when the guest is nested.

## Answer in brief

- **Nested workers work in the view, under its policy, on all three engines.** The relay starts from the view's
  `blob:` URL, and the guest starts from a `blob:` URL the relay mints. The guest inherits the view's policy exactly:
  `eval`, `importScripts` and `fetch` are refused, and positive controls with `connect-src` arrive. Under COEP
  `require-corp`, WebKit refuses the view's own worker, as it does today, so nesting is never reached there.
- **Messages: the relay closes the guest's own `postMessage` by construction.** A flood of 8 MiB buffers to the view
  kept the host page 98% busy in Chromium's headless shell, 58–63% in Firefox and 29% in WebKit. The same flood to a
  relay costs the host page 0–2% on every engine, whether the relay forwards bounded notices, forwards nothing or has
  no listener. The relay's own thread is 93–100% busy.
- **Uncaught errors: closed, provided the relay cancels them.** With the relay cancelling at the guest's `Worker`
  object, a flood of 16 Mi-character errors costs the host page 0–1% everywhere, whatever the guest realm does. If the
  relay does not cancel, the error is reported again in the relay and reaches the view: 53–87% busy in the headless
  shell, Firefox and WebKit, as with no relay.
- **Unhandled rejections: not closed, and Firefox's 99% does not go away.** A rejection is reported on the guest's
  own global and never reaches a `Worker` object, so no trusted realm sees it. With a 16 Mi-character `Error` as the
  reason, Firefox's host page stayed 96–98% busy in all four layouts, nested or not, cancelled or not. Chromium's
  headless shell stayed 41–77% busy when the guest did not cancel, nested or not. WebKit and Chromium's desktop
  build stayed at 0–1%.
- **Overheads are small.** Per sandbox the relay adds about 1.8–1.9 MB (PSS) on all four, and 0.02–0.1 ms to the mean
  RPC round trip. It adds 14–21 ms to the time from INIT to the guest's first message.
- **Termination and the watchdog work through the relay.** Terminating the relay ends the nested guest on every
  engine, and the watchdog finds an endless loop in 1.00–1.05 s in both layouts. In Chromium, a terminated worker that
  never yields keeps running for about 2 s in both layouts. That is not new, and the relay does not change it.
- **Verdict: build it, with caveats per engine.** It closes the worker side of E-cpu (messages and errors) and G (the
  worker side's measuring) by construction. It does not close rejections (5:N-1), so S64's rejection budget and its
  ending of the sandbox stay. The relay needs a byte budget that ends the guest, because a flood saturates the relay's
  thread and grows memory by about 1 GB a second (see [Verdict](#verdict)).
- **Decision (owner, 2026-10-19): deferred.** The floods it would move are already bounded (the worker's `postMessage()`
  is gone; the uncaught budget ends the sandbox), so under the rule for availability findings (CONTRIBUTING.md) the
  remaining cost is documented. The design is kept for the case where a bound is found not to hold (backlog S69).

## Method

Like research 15, the probes use no library runtime code. [`harness.ts`](harness.ts) builds strict mode's topology with
the library's own pure builders, read only: `buildWrapperDocument` with `allow-scripts allow-forms`,
`buildViewDocument`, `strictViewPolicy` (`worker-src blob:`, a hash-only `script-src`, `default-src 'none'`) and
`scriptHashSource`. The view runs one hash-admitted bootstrap that spawns one worker from a `blob:` URL it mints:

```
host page (host.html; ?coep=require-corp adds Cross-Origin-Embedder-Policy)
└─ wrapper  as the element builds it in strict mode
   └─ view  the strict view policy + one bootstrap
      ├─ 'direct' (today):    new Worker(blob:) ─ guest
      └─ 'relay' (proposed):  new Worker(blob:) ─ relay ─ new Worker(blob: minted by the relay) ─ guest
```

- The relay holds the logic port and the guest's `Worker` object.
- It measures each frame from the guest with the library's own `createSizeOf` (`structured-size.ts`, stringified)
  and forwards frames under 1 MiB.
- It handles the guest's other traffic per variant: bounded notices to the view (at most 100 a second), nothing, no
  listener, or everything (a control).
- It cancels the guest's errors when told to and reports them at most 10 a second, cut to 200 characters.
- The guest's prelude cancels its own errors and rejections when told to, as the library's prelude does.

Floods are the reviewers' shapes, each stopped after 2.6 s:
- (a) `Promise.reject(new Error('x'.repeat(2 ** 24)))`, twice per 0 ms tick;
- (b) `reportError` of the same error, twice per tick;
- (c) four 8 MiB `Uint8Array`s per tick through the guest's own `postMessage`.

Host busy is `1 − ticks under the flood / idle ticks` of a 10 ms interval over 2 s windows, with the sandbox mounted
for both. The relay counts its own 10 ms ticks the same way. During the flood the host pings the guest over the logic
port, one ping at a time, each given 1 s (the watchdog's view).

**Standalone, not under Playwright, for the floods.** Playwright's Firefox (Juggler) forwards every worker console
message whole to the driver. Under a 16 Mi-character flood the driver fell more than 1 GB behind and the test hung. So
every flood also runs in a browser started on `host.html?auto=<id>` alone, with no DevTools client attached; the page
posts its result to the probe server. The tables below are the standalone runs, two each. Under Playwright, Chromium
and WebKit gave the same shapes (one run each), except Chromium's rejection floods, whose logic pings timed out.

**A memory guard.** The VM's memory is shared. A browser whose processes pass 4 GiB (PSS) is stopped, and the stop is
recorded as the result ("stopped"). An earlier run with 4 s windows had Firefox's content process killed by the kernel
at 9.4 GB during the rejection flood.

## Q1. Nested workers in this context

| | Chromium shell | Chromium desktop | Firefox | WebKit |
| :--- | :--- | :--- | :--- | :--- |
| Host page, no COEP: a blob: worker; a blob: worker's own blob: worker; a same-origin script worker's blob: worker | all three run | all three run | all three run | all three run |
| Host page, COEP `require-corp`: the same three | all three run | all three run | all three run | all three run |
| The view, direct: the guest starts | yes (`blob:null/…`) | yes | yes | yes |
| The view, relay: the relay starts, and the guest nested in it | yes (`blob:null/…`) | yes | yes | yes |
| The view under COEP, direct | starts | starts | starts | **refused**: an error event with no message, and the worker never runs (as `host-policy.spec.ts` asserts today) |
| The view under COEP, relay | starts | starts | starts | **refused the same way**: the relay itself is the view's worker, so the nested spawn is never reached |
| The nested guest's policy (the same for the direct guest): `eval`, `Function` / `importScripts(blob:)` / `fetch` to a loopback canary / `fetch(blob:)` / `self.origin` | `EvalError` / `NetworkError` / `TypeError`, 0 requests arrived / `TypeError` / `'null'` | same | same | same |
| Positive control: `connect-src` with the canary's origin and `blob:` | both fetches succeed, 1 request arrived | same | same | `blob:` fetch succeeds; the `http:` canary is upgraded to `https:` and fails (research 16) |
| A third-level `new Worker(blob:)` from the guest | constructed | constructed | constructed | constructed |

WebKit refuses the view's worker under COEP only in the sandboxed opaque-origin view. On the host page itself, under
the same header, a blob: worker and its nested blob: worker both run. A relay does not change what strict mode needs
from the host page. A guest can still nest further, as today, so the library's globals allowlist must keep deleting
`Worker` in the guest.

## Q2. Where the costs land

Host-page busy %, standalone, two runs. "Cancels" means `preventDefault()`: in the guest realm on its own global, in the
view or the relay on the `Worker` object it holds. A dash means the browser passed the 4 GiB guard before the window
ended.

**(a) Unhandled rejections, a 16 Mi-character `Error` as the reason**

| Layout | Chromium shell | Chromium desktop | Firefox | WebKit |
| :--- | :--- | :--- | :--- | :--- |
| direct, the guest cancels (today, S64) | 0, 1 | 0, 0 | **96, 96** | 0, 0 |
| direct, nothing cancelled | 41, 67 | 0, 0 | **96, 97** | 0, 1 |
| relay, nothing cancelled (the relay cannot: no event reaches it) | 56, 77 | 0, 1 | **98, 98** | 0, 1 |
| relay, the guest cancels | 0, 6 | 0, 0 | **98, 98** | 0, 0 |

| Control | Chromium shell | Chromium desktop | Firefox | WebKit |
| :--- | :--- | :--- | :--- | :--- |
| A one-character `Error`: direct, cancelled / relay, not | 0, 0 / 0, 3 | 0, 2 / 0, 0 | 0, 0 / 0, 1 | 0, 0 / 0, 0 |
| The 16 Mi-character string itself as the reason: direct, cancelled / relay, not | 0, 0 / 61, 63 | 0, 0 / 0, 1 | **98, 98** / 0, 1 | 0, 1 / 0, 0 |

- **Firefox:** the cost scales with the reason's size, as the one-character control shows. Neither cancelling nor
  nesting moves it for an `Error` reason. Nesting does move it for a string reason. The cost is also memory: the
  browser reached 1.8–2.0 GB within the 2.6 s flood.
- **Chromium headless shell:** cancelling in the guest removes the cost; nesting does not.
- **The logic port during the flood:** in Firefox, only two pings could be sent during the window, and one or both went
  unanswered within 1 s in every layout, because the host page itself was busy.

**(b) Uncaught errors, `reportError` of a 16 Mi-character `Error`**

| Layout | Chromium shell | Chromium desktop | Firefox | WebKit |
| :--- | :--- | :--- | :--- | :--- |
| direct, the guest cancels (today) | 1, 0 | 0, 0 | 0, 2 | 3, 1 |
| direct, the view cancels at its `Worker` object | 0 (one run gave no result in 60 s) | 0, 0 | 0, 0 | 2, 0 |
| direct, cancelled nowhere | 63, – | 26, – | 84, 82 | 78, 79 |
| relay, the relay cancels at the guest's `Worker` object | **0, 0** | **0, 0** | **0, 0** | **0, 0** |
| relay, the guest cancels too | 0, 0 | 0, 0 | 1, 1 | 1, 0 |
| relay, cancelled nowhere (passed on to the view, as the spec says) | 53, 78 | 4, – | 83, 87 | 78, 75 |
| relay passes it on, the view cancels | 49, 64 | 12, 0 | 0, 0 | 1, 2 |

The relay must cancel. An error a nested worker's parent does not cancel is reported again in the parent's global
(measured: it reached the view's `Worker` object), and in Chromium cancelling it one level later is too late. With the
relay cancelling, the host-page cost no longer depends on the guest realm.

**(c, d) The guest's own `postMessage` of 8 MiB buffers**

| Layout | Chromium shell | Chromium desktop | Firefox | WebKit |
| :--- | :--- | :--- | :--- | :--- |
| direct, to the view (round 4's M-1 before its fix) | **98, 98** | –, – | **63, 58** | **29, 29** |
| relay, measured, bounded notices to the view | 0, 0 | 0, 0 | 2, 1 | 1, 0 |
| relay, a listener that forwards nothing (d) | 0, 0 | 0, 0 | 1, 0 | 0, 1 |
| relay, no message listener (d) | 0, 0 | 0, 0 | 2, 1 | 0, 0 |
| relay, forwarded whole to the view (a control) | 99, 99 | –, – | 79, 80 | –, – |

- **Chromium desktop:** the view is out of process. The direct flood passed the memory guard in 4.3 s; under
  Playwright, the same flood cost the host page 1%.
- **Memory:** every layout grew the browser to 0.8–3 GB during the 2.6 s flood.
- **The logic port during the flood:**
  - Direct, the logic port is separate from the guest's own traffic. Pings were answered within 92–116 ms in Firefox
    and WebKit, and within 666–742 ms in Chromium's shell, whose host page was 98% busy.
  - Through the relay, the guest's PONG waits in the same queue as its own flood. Only 2–4 pings could be sent. The
    answered ones took 450–990 ms, and up to two per window went unanswered within 1 s (Firefox: both, in every run).
    The host page stayed free; a watchdog with a 1 s limit would end that guest.

## Q3. Measuring in the relay

Under the `postMessage` flood (c), standalone, two runs:

| | Chromium shell | Chromium desktop | Firefox | WebKit |
| :--- | :--- | :--- | :--- | :--- |
| Relay thread busy | 93–98% | 94–98% | 99% | 95–100% |
| Messages received by the relay per second (8 MiB each) | 143–150 | 136–152 | 117–130 | 537–571 |
| The library's measure per message (`createSizeOf` of a `Uint8Array`) | 3–60 µs | 0–49 µs | 0–78 µs | 0–42 µs |
| Host page busy, relay forwarding bounded notices | 0% | 0% | 1–2% | 0–1% |
| The relay with no listener at all: relay busy | 95–97% | 98% | 99% | 96–100% |

- **The cost of receiving is in the platform, not in the measure.** The relay is saturated even with no listener: a
  message is received, and in Chromium deserialized, whether or not anyone reads it. The measure itself is tens of
  microseconds per frame.
- **None of it reaches the host page,** unless the relay forwards the payload (the "forwarded whole" control:
  79–99%, or past the memory guard). Measuring after deserialization is affordable. What a relay forwards is a fresh,
  bounded frame, so the host and the view only ever deserialize what the relay allowed.
- **What a flood still costs:** the relay's thread and memory. The guest's queue to the relay grows by about 1 GB a
  second (the floods' peak memory above), and no budget can see a message before the platform delivers it.
- **Not measured:** the measure's cost on deeply nested object graphs. The walk stops at the limit (1 MiB), so its work
  is bounded by the limit (`structured-size.ts`).

## Q4. Overheads

Playwright, one page per sample, idle sandboxes. Memory is the median of five samples of 20 sandboxes, each against its
page's baseline before mounting, summed over every process of the browser. RPC is 1000 sequential `{ id, args }` round
trips after 200 to warm up. Ready is 20 mounts of each, interleaved, after one discarded.

| | Chromium shell | Chromium desktop | Firefox | WebKit |
| :--- | :--- | :--- | :--- | :--- |
| Memory per sandbox, direct → relay (PSS) | 3.7 → 5.7 MB | 4.7 → 6.6 MB | 3.6 → 5.5 MB | 4.5 → 6.3 MB |
| **Extra per sandbox for the relay** | **+1.9 MB** | **+1.9 MB** | **+1.8 MB** | **+1.8 MB** |
| RPC round trip, direct: mean / p50 / p95 / p99 (ms) | 0.06 / 0.1 / 0.1 / 0.4 | 0.07 / 0.1 / 0.2 / 0.3 | 0.29 / 0 / 1 / 2 | 0.53 / 1 / 1 / 2 |
| RPC round trip, relay: mean / p50 / p95 / p99 (ms) | 0.12 / 0.1 / 0.2 / 0.4 | 0.12 / 0.1 / 0.2 / 0.4 | 0.39 / 0 / 1 / 2 | 0.56 / 1 / 1 / 3 |
| Time to the guest's first message from INIT_VIEW, p50 (p95), direct → relay | 15 (54) → 33 (66) ms | 16 (40) → 30 (57) ms | 15 (29) → 30 (52) ms | 25 (58) → 46 (106) ms |
| The same from inserting the frame, p50 | 35 → 51 ms | 57 → 69 ms | 50 → 62 ms | 65 → 69 ms |

- **Timer resolution:** Firefox and WebKit report the host page's `performance.now()` in whole milliseconds here. Their
  percentiles cannot resolve the hop; the means can.
- **A first run of the same test:** 10 sandboxes, three samples, and readiness from INIT_VIEW of 7.5 → 16.8 ms
  (Chromium shell) and 13 → 25 ms (Firefox). It had the same extra memory, except Firefox's direct samples, which
  were noisy (−1.8 to 4.3 MB).

## Q5. Error muting after the guest's URL is revoked

A late uncaught error (`throw` from a timer), the guest not cancelling it. The URL was revoked by whoever minted it
(the view in direct, the relay in relay) after the guest started, as the library revokes it after VIEW_STARTED (C1).

| | Chromium (both builds) | Firefox | WebKit |
| :--- | :--- | :--- | :--- |
| Not revoked: in the guest / on the `Worker` object | full text / full text | full text / full text | full text / full text |
| Revoked, direct: in the guest / on the view's `Worker` object | full text / full text | full text / full text | **"Script error.", no error object** / full text |
| Revoked, relay: in the guest / on the relay's `Worker` object | full text / full text | full text / full text | **"Script error.", no error object** / full text |

Nesting changes nothing. WebKit still mutes the error inside the guest, and the `Worker` object still has the text,
now in the relay. So the library's fallback for muted errors (the view logs what the guest could not describe,
GUEST_UNCAUGHT) moves into the relay unchanged, and it no longer runs on the host page's thread.

## Q6. Termination, the watchdog and the execution timeout

The guest posts a heartbeat every 20 ms to the host on a port of its own: the probe's instrument, which is not in the
design. The table gives the last heartbeat after the termination, in ms; 0 means none arrived. Playwright, two runs.

| Guest; action | Chromium shell | Chromium desktop | Firefox | WebKit |
| :--- | :--- | :--- | :--- | :--- |
| On timers; the view terminates its worker (the guest, or the relay) | 0, both layouts | 0 | 0 | 0 |
| On timers; the frame is removed | 0 | 0 | 0–6 | 0 |
| On timers; the relay terminates the guest | 0 | 0 | 0 | 0 |
| An endless loop; the view terminates its worker | **1983–1996**, both layouts | **1994–1996**, both layouts | 0–2 | 4–27 |
| An endless loop; the frame is removed | **1991–1995**, both layouts | 0–7 | 0 | 2–39 |
| An endless loop; the relay terminates the guest | **1983–1994** | **1984–1991** | 0 | 0–36 |
| The watchdog (a ping every 250 ms, 1 s to answer): found the loop after | 1000–1001 ms, both layouts | 1000–1001 ms | 1002 (direct), 1023–1053 (relay) | 1000–1001 ms |
| The healthy logic round trip before it: p95, direct / relay | 0.5 / 0.8–2.6 ms | 1–4.3 / 1.4–1.5 ms | 2 / 3 ms | 3–8 / 2–6 ms |

- **Terminating the relay ends the nested guest on every engine,** at the same moment as terminating today's worker.
- **In Chromium, a worker in a loop that never yields keeps running for about 2 s after `terminate()`,** in both
  layouts. In the headless shell the same 2 s follow a frame removal. This is measured; the cause (a grace period
  before forcible termination) is inferred, not read. It is already true today, and the relay neither adds to it nor
  removes it.
- **The watchdog and the execution timeout work unchanged.** The execution timeout is the same ping at a deadline.
  The relay forwards PING and PONG and never answers for the guest.

## Q7. What could break the design

- **Nothing found that stops it on the three engines in this context.** Nested `blob:` workers start under the view's
  policy everywhere strict mode starts at all.
- **Rejections are reported where no trusted realm can see them** (Q2a). In Firefox their cost lands on the host page
  whatever the layout. The relay changes nothing for 5:N-1.
- **A relay that does not cancel an error passes it on to the view** (Q2b). Cancelling is the relay's job, in its own
  listener, on every error.
- **The relay's thread and memory are the guest's to exhaust** (Q2c, Q3). This is not the host page's thread, but
  without a byte budget that ends the guest, a flood grows memory by about 1 GB a second.
- **One queue for control and flood traffic.** In the relay layout the guest's PONG waits behind its own traffic, so a
  flooding guest fails the watchdog. That fails closed, but a legitimate burst of large frames could also delay a PONG.
- **Not measured:** Safari on macOS and iOS (WebKit 26's Linux build only), Android WebView, and the relay's own CPU
  share on a busy machine. Worker mode (its frame spawning the relay) was not built here, only strict mode's topology.

## Verdict

**Build it, with caveats per engine.**

### What it would close by construction

- **E-cpu, the worker side.** Every channel a guest worker has to its parent ends in the relay's thread: its own
  `postMessage`, its uncaught errors (the relay cancels them in a realm the guest cannot reach), and every frame
  of the logic and render ports. The host page and the view only ever receive frames the relay made. This covers
  4:M-1, 3:C-4's worker half, 1:R3-3's worker half and 3:M-2's call rate made bypass-proof.
- **G, the worker side.** Measuring and budgeting happen after deserialization, on plain data in a trusted realm.
  There is no getter to lie, no intrinsic to replace, and no snapshot discipline in guest-realm code. The guest-realm
  relay and broker become functional only: a guest that subverts them loses its own logs and calls, and cannot exceed a
  budget. This covers 2:C-1, 2:C-2, 2:C-3, 4:C-1 and 5:N-2's worker half. It also makes WebKit's muted-error fallback
  (C1) run off the host page's thread.

### What stays open

- **Unhandled rejections (5:N-1).** No `Worker` object ever sees them. The guest-realm listener that cancels them, and
  S64's per-second rejection budget that ends the sandbox past it, stay. In Firefox the budget is the only bound,
  since cancelling does nothing there.
- **The relay itself.** Its thread can be saturated and its memory grown by the guest. It needs a byte budget per
  second and a cap on bytes received, past which it terminates the guest and says why.
- **Everything not on the worker side:** the view's rendering cost (P), L, C, cooperative mode, and the view realm's own
  guest values (DOM events, writes).
- **Chromium's 2 s after `terminate()`** for a non-yielding loop (unchanged, not new).
- **WebKit under COEP `require-corp`** (unchanged: strict mode cannot start there).

### For design 2 (one reader for guest values)

Its worker-side half becomes unnecessary as a security property: the relay is the one reader. Design 2 is still needed
for the view's realm (event and write values the view reads), for cooperative mode, and for the guest-realm rejection
listener, which must read `reason` once through a captured getter. So design 2 shrinks to those three places, and
S64's N-2 and N-6 slices stay as they are.

### Implementation plan

1. **The relay** (`src/lib/relay-worker.ts`): a self-contained, stringified `inRelayWorker`, like `inStrictWorker`.
   - It is started by the view's bootstrap from a `blob:` URL, under the view's inherited policy.
   - It receives the logic port and the render port in INIT, and the guest's source.
   - It mints the guest's `blob:` URL, spawns the guest, and revokes the URL at VIEW_STARTED (C1 moves here).
2. **One frame protocol guest → relay**, over the guest's own `postMessage`: calls, logs, renders, PONG. The relay
   measures each frame with `createSizeOf` and charges it to the existing budgets (calls, log lines, render
   characters, URLs), keyed by frame type. A frame past a budget is dropped and its drop said once, as today. The
   guest's `postMessage` no longer needs removing from its globals.
3. **A hard bound in the relay.** Past a byte rate or a total in flight, the relay terminates the guest and reports a
   reason the host turns into `terminated`. This must be measured against the floods above, to set the cap below the
   memory a flood reaches before the relay sees the frames.
4. **Errors in the relay.** It cancels every error on the guest's `Worker` object, decides which are the entry's
   (VIEW_STARTED's count moves here), and posts GUEST_ERROR or GUEST_UNCAUGHT bounded and rate-limited.
5. **What stays in the guest realm.** The rejection listener (cancel and relay a bounded line) and S64's rejection
   budget, read once through a captured getter (design 2's remaining slice).
6. **The view.** It keeps only the render port's apply path and the view port. It no longer listens on a guest's
   `Worker` object at all.
7. **Worker mode.** The same relay, spawned by the worker-mode frame's bootstrap. Probe it first: its frame's policy is
   the cooperative one.
8. **Tests.**
   - Port this probe's floods into e2e: host busy and relay-ends-guest under (a), (b) and (c), on all three engines.
   - A guest that replaces every prototype method and global its prelude uses still cannot exceed a budget.
   - The egress table (design 1) gains a "lands in" column: relay or host.

**Cost:** L, 2–3 weeks, as research 18 estimated, plus the probe for worker mode.

### Risks

- **The relay is one more stringified realm,** with the same capture discipline as the others, and one more lifecycle
  stage (relay up, guest up) for the lifecycle reducer (S65) to own.
- **The cap in step 3** is a new measured constant per engine. Set too high, a flood still costs gigabytes before the
  guest is ended.
- **Readiness takes 14–21 ms longer** from INIT (p50), and each sandbox about 1.9 MB more.
- **A flooding guest delays its own PONG** behind its traffic. That fails closed. A separate MessageChannel for control
  frames would not help, because the relay's thread is the bottleneck.
- **Engines outside this matrix** (Safari on Apple platforms, Android WebView) are unmeasured.

## Files

- [`probe.spec.ts`](probe.spec.ts): Q1–Q6, with `MEASURED` lines the tables are made from. The floods run standalone
  (browsers started without Playwright attached) and, for comparison, under Playwright.
- [`harness.ts`](harness.ts): the view's bootstrap, the relay, the guest's prelude and scenarios, and the documents
  built with the library's own builders and policy.
- [`host.html`](host.html): the host page, including the flood measurement and the standalone mode
  (`?auto=<id>`).
- [`server.mjs`](server.mjs): the Bun server, with the host page and the job/result store on 5050 and the network
  canary on 5051.
- [`playwright.config.ts`](playwright.config.ts): four projects (the headless shell, the full Chromium build,
  Firefox, WebKit), one worker.

Run from the repository root. The root config lists these tests and skips them; they have their own config and server:

```
bunx playwright test -c docs/research/19_relay_worker                        # everything, about 45 min
bunx playwright test -c docs/research/19_relay_worker -g standalone --repeat-each 2
bunx playwright test -c docs/research/19_relay_worker -g "Q1|Q4|Q5|Q6"
```

The floods use several GB of memory each. The spec stops a browser past 4 GiB and records the stop as the result.
