# Research 18: the classes behind the findings, and how to close them by construction

**Question (owner, during review round 5).** Do the bugs that keep coming up share a common problem class, and is
there a better way to close all of them by construction?

**Inputs.** Every report in `docs/security/`:
- the adversarial, focused and broad reviews and the verification;
- review rounds 1 to 4.

Also the S-items of the backlog, the code at `60814b5`, and
[research 17](../17_formal_methods/README.md). Review round 5's audit (N-1 to N-7) and lifecycle findings (L-1 to L-4)
are counted in the tables below. Its limits measurement (M-1 to M-4) reported after the tables were written and is
placed in [Round 5's limits measurement](#round-5s-limits-measurement).

**Decided (owner, 2026-10-18).** All recommendations adopted: round 5's fixes are made as the first slices of their
classes' designs; every fix names its class and extends that class's list or structural test; the plan after round 5
is the order below (backlog S64–S69).

## Answer in brief

- **Yes, there are a few common classes.** The 56 medium-or-higher findings fall into seven structural classes plus
  packaging; an eighth class has only lows. Five of the seven still produce new findings after fixes: E-cpu, P, G, L
  and C. E-net is closed in the default mode, and B is closed except where a fix adds a new model. Parts of the
  recurring classes were closed too: policy config (C), intrinsic lookups (G) and the RPC measure (P).
- **Every class that was closed was closed the same way.** A list of bad things was replaced by a list of allowed
  things, and a test enumerates the domain mechanically:
  - the typed-origin template (S47);
  - the renderer allowlist (S38);
  - the worker-globals allowlist (S43);
  - captured intrinsics with a source scan (round 2);
  - the frame builders with the snapshot measure (rounds 2 and 3).

  None of these classes has produced a medium finding since.
- **The classes that keep recurring are the ones with no such list:**
  - the platform's event and message surfaces that cause host-thread work (egress);
  - guest-supplied objects read by library code;
  - lifecycle transitions and the dispatch of events;
  - cross-field config invariants;
  - the cost of the view's work on a shared thread.

  Their fixes have been per instance. Several later findings repeat an earlier symptom exactly: round 5's L-1 is the
  broad review's CB3 again, round 5's L-2 is round 4's C-6 again, and round 5's N-1 is the half of round 4's M-1 that
  the fix did not cover.
- **Four by-construction changes cover the recurring classes in our own logic:**
  - an egress table with an enumeration test;
  - one reader for guest values at the boundary;
  - one lifecycle reducer with a single ready gate;
  - one config schema.

  A fifth rule covers re-derived browser policy: a library model of a browser decision may only be stricter than the
  browser, and the budget must not depend on it being right. Each change comes with the S61 test that keeps it closed.
- **About a third of rounds 1–5's mediums come from one architectural fact:** in Firefox and WebKit, the view shares
  the host page's thread. No library design moves the view off that thread (research 16), so this class cannot be
  closed by construction. It can only be narrowed:
  - allow only features whose cost is bounded, as `allowAnimations: false` does;
  - state the bound honestly.

  A larger change, a trusted relay worker between the guest's worker and the host, would move the guest-generated
  share of that work off the host thread. It would also turn the guest-realm budget code from a security property into
  a functional one. It needs a probe before anyone commits to it.
- **Merging the library's own ports into one multiplexed port** would by itself have prevented only about 5 of the 56.
  Most egress findings came through platform surfaces, not through the library's ports.

## Method

1. Every finding of the eight reports rated medium or higher, in either half of a split rating such as "medium/low",
   is listed with its fix. Round 5's findings so far are included. Research 17 counted the same 48 for the reports up
   to round 3. Round 4 adds 5, and round 5 adds 3 so far: 56 in all.
2. Lows that recur in the same class are listed apart.
3. Each finding is given the **invariant it violated**, not its symptom. Its class is the invariant's family. Where a
   finding belongs to two classes, the second is noted, and only the first is counted.
4. A class is **recurring** when it produced a new instance after a fix of the same class. A class is **closed** when
   a change made the bad state unrepresentable or mechanically checked, and no medium-or-higher instance followed.
5. "Would have prevented" is a judgement: would the design, had it existed before the finding, have made the finding
   impossible, or made a test fail? It is not an experiment. The counts are given so that they can be disputed.

Notation: `2:C-1` is round 2's C-1, and `1:R3-1` is round 1's R3-1. The earlier reviews' IDs (A1, W1, CB1, PD1, ST1,
V1 …) are unique and keep no prefix.

## The classes

| Class | The invariant that was violated |
| :--- | :--- |
| **E-net**: egress the policy does not govern | Every way guest code can reach the network, navigate or take a user-agent surface (focus, clipboard, history) is governed by the policy or absent. |
| **E-cpu**: host-thread work outside the chokepoint | Every way guest activity can cause host-thread work passes one chokepoint that bounds it before the work is done: rate, bytes, and cut before posting. |
| **P**: a budget that counts a proxy | A budget or a measure counts the cost it claims to bound: the bytes actually posted, or the time actually spent. It does not count a stand-in such as characters, own keys, the arguments only, or the flush only. |
| **G**: guest-controlled state read by library code | Library code never consults state the guest controls: intrinsics and prototypes, listeners, accessors, the realm's declarations. A guest-supplied value is read once, as a snapshot. |
| **L**: lifecycle | Each transition is reachable by one path, guarded by one predicate. Events are dispatched only after the state has settled, never from inside the embedder's own call. Queued work is released only at the gate it waits for. An actor of an old environment cannot act. |
| **C**: config | A config's validity, including cross-field and platform-domain invariants, is decided in one place, before anything is stored or built. |
| **B**: a browser decision re-derived | Where the library predicts a browser decision (what policy applies, what loads, what runs, what a mechanism changes later), the prediction agrees with the browser, or errs only toward refusing. |
| **D**: derived state (lows only) | One state (the guest-write overlay) has several projections: the list, the announcement, the view's copy, the guest's answer. All of them come from one diff of that state. |
| **O**: packaging | — |

## Every medium-or-higher finding

Severity is as reported. "Closed by" says whether the fix closed the class ("class") or the case in front of it
("instance").

### The earlier reviews (21)

| ID | Sev | Finding | Fix | Invariant violated | Class | Closed by |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| A1 | med/high | A config value or key added CSP directives | Grammar (S19), then typed origins and a template (S47) | Policy text was built from the embedder's strings | C | class (S47) |
| A2 | low/med | Punctuation got past the `'self'` drop | As A1 | As A1 | C | class (S47) |
| A3 | low/med | The bootstrap check ignored `script-src-elem` | A fallback table, then S47: every directive explicit | The library re-derived CSP's fallback order | B | class (S47) |
| B1 | med/low | INIT_PORT was accepted from any sender | One trusted INIT_PORT, then the reversed handshake (CB1) | The library's capability travelled on a channel others can post to | G | class (CB1) |
| B2 | med/low | A patched `MessagePort.prototype` took the port | Captured primitives | Library code looked up guest-mutable intrinsics at call time | G | class (capture; scan since 2:C-1) |
| B3 | med/low | Log frames were dispatched raw, with no rate | `_dispatchLog`; 1000 lines/s | A path from guest to host event with no normaliser or rate | E-cpu | class for logs only |
| B4 | low/med | Firefox delivered an old port's frames after `reset()` | Port identity | An old environment's actor could act | L | class (port identity) |
| C1 | med/low | The `blob:` rule read attributes only; CSS names URLs too | The worker's source URL revoked | The model of "what loads a URL" missed CSS | B | class for `blob:`; CSS URLs remain (4:M-2) |
| C2 | low/med | The entry's declarations were instantiated before the prelude | Own scope plus a check; ST4 added a random marker | The guest shapes the realm before library code runs | G | instance, twice (ST4) |
| W1 | high | A committed inert file ran as a script | The load-kind table | The library assumed a type decides execution; engines run a classic `blob:` script of any type | B | class (one table) |
| F1 | med | SMIL re-animated checked hrefs | Animation elements removed, then the allowlist renderer (S38) | A denylist did not know a mechanism that changes attributes after the check | B | class (allowlist) |
| F2 | med | The execution budget ended on the guest's word; `Function` was looked up | A probe that the event loop is free; `Function` captured | A budget ended on a signal the guest controls | G | class |
| CB1 | med/low | `document.open()` erased the port listener | The reversed handshake | The capability was delivered into the guest realm | G | class |
| PD1 | high (WebKit) | A `data:` SharedWorker ran past the policy | No `data:` workers; unrepresentable since S47 | Egress the policy does not govern on one engine | E-net | class |
| PD2 | high (Firefox) | A keepalive `fetch` went past `connect-src` | A guest-realm wrapper | As PD1 | E-net | strict: class (S48); cooperative: frozen limit |
| PD3 | med | Preconnect | A meta tag; residual | No directive governs it | E-net | as PD2 |
| PD4 | med | `history.back()` moved the host page | Guest-realm no-ops | Navigation outside the policy | E-net | as PD2 |
| PD5 | med | Focus and the clipboard | Documented | User-agent surfaces outside the policy | E-net | as PD2 |
| ST1 | med | An SVG behind a minted URL opened as a script-running document | `VIEW_FILE_TYPES` allowlist | The library assumed `image/*` is inert | B | class (allowlist) |
| ST2 | med | `<use>` and `marker` fan-out stalled the host page | Allowlist; element and depth caps | Markup size stood for render work | P | class for instancing; the proxy remains (S42) |
| V1 | high (Firefox) | The worker's EventSource and FontFace ignored the policy | `WORKER_GLOBALS` allowlist (S43) | A denylist of egress APIs | E-net | class (allowlist) |

### Review round 1 (9)

| ID | Sev | Finding | Fix | Invariant violated | Class | Closed by |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1:R3-1 | med | The frames inherit the host page's CSP, Trusted Types and COEP | `VIEW_READY` gate, one TT policy, reasons | The library assumed its own policy was the only one in force | B (L) | instance; 2:C-5, 2:C-6 and 5:L-1 followed |
| 1:R4-1 | med | The relay threw `DataCloneError` | One relay that never throws | A guest value crossed a boundary whose input domain was not total | G | class for log lines |
| 1:R1-1 | med | Text was in no view budget | Character budgets | The budget counted elements, not text | P | instance |
| 1:R1-2 | med | Super-linear layout (`wbr`, `ruby`) | Unwrapped; a linear walk | Markup size stood for layout cost | P | instance |
| 1:R3-3 | med | No byte caps on logs or RPC | Byte caps and per-second budgets | Channels with no budget | E-cpu | per channel |
| 1:R4-2 | med | Cooperative and worker uncaught errors never reached `sandbox-log` | Relay listeners | A platform error surface was not wired to the chokepoint | E-cpu | instance; the same listener is 5:N-1 |
| 1:R4-3 | med | The `.d.ts` broke under NodeNext | Specifiers; smoke test | — | O | class (smoke test) |
| 1:R2-2 | med | A synthesized modifier click opened a tab; a form went past `form-action` | Documented; `allow-forms` became unsafe | Navigation outside the policy (cooperative) | E-net | frozen limit |
| 1:avail | med | Availability is not protected where the view shares the host's thread | The claim restated | The budgets bound proxies on a shared thread | P | documented (architecture) |

### Review round 2 (10)

| ID | Sev | Finding | Fix | Invariant violated | Class | Closed by |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 2:C-1 | high | The guest's `Math.min` lifted the relay's caps | `CAPTURE_POINT` plus a scan | Intrinsics looked up at call time | G | class (for global lookups) |
| 2:C-3 | high | The size measure walked own keys only; senders measured the live value | Measure the snapshot that is posted | What was measured was not what was sent | P (G) | class (RPC and log measure) |
| 2:C-2 | med | Spread in `console.trace` went through a patched iterator | Index loops | As 2:C-1 | G | class (scan) |
| 2:C-4 | med | `set({ value })` re-serialized the body, charged its own characters | Running counts | The charge stood for the work | P | instance |
| 2:C-5 | med | Worker mode was `ready` before `new Worker` | `WORKER_STARTED` | "Ready" was defined per mode, at a point before the guest existed | L | instance |
| 2:C-6 | med | Under a host TT default policy: no reason given; `ready` with no worker | Probe `createPolicy` | As 1:R3-1 | B | instance (it delegates: it asks the browser) |
| 2:C-7 | med | The equal-config check was exponential | Visited set, cap | Processing of embedder input had no bound | C | instance |
| 2:C-8 | med | `viewScriptHash` import threw; the hash differed when minified | Baked literal | — | O | class |
| 2:L-1 | med | Builds ran in another window's document | One `buildsHere()` | One transition guarded by two predicates on two paths | L | class for that predicate |
| 2:L-2 | med | Delays of 2^31 ms or more fired at once | `long-timer.ts` plus a scan | A caller value was not checked against the platform API's domain | C | class for timers |

### Review round 3 (8)

| ID | Sev | Finding | Fix | Invariant violated | Class | Closed by |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 3:C-1 | high | Method names and error text crossed whole | Frame builders, frames measured whole | Part of the frame stood for the frame | P | class (builders; S61 brands them) |
| 3:M-1 | high | CSS animations defeated the time budget | `allowAnimations` | Time-driven work is invisible to a per-flush measure | P | an option, default `true` |
| 3:C-2 | med | Hidden time was charged as work | Charge only measured rendering | The charge stood for the work | P | instance |
| 3:M-2 | med | Call throughput was unbounded | `callLimits` | A channel dimension with no budget | E-cpu | instance |
| 3:C-3 | med | A nested Error was reported as past the byte budget | Errors relayed | The boundary's input domain | G | instance |
| 3:C-4 | med | The view relayed the entry's error text uncut | Cut and rate-limited in the view | A second path for guest text, outside the relay's chokepoint | E-cpu | instance |
| 3:L-1 | med | Re-insertion from a `terminated` listener left the element connected and `idle` | The rule moved onto the answer | Re-entrant dispatch | L | instance; 4:L-3 followed |
| 3:L-2 | med | A call whose argument getter terminated the element never settled | Each call records its environment | Re-entrancy mid-call | L (G) | instance |

### Review round 4 (5)

| ID | Sev | Finding | Fix | Invariant violated | Class | Closed by |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 4:M-1 | med | The worker's own `postMessage`; worker-mode errors not cancelled | `postMessage` removed; errors cancelled | Platform surfaces outside the chokepoint | E-cpu | instance: the code names "the class of M-1" but cancels errors only, so 5:N-1 followed |
| 4:C-1 | med | `error.message` read twice | Read once; a scan for "typeof, then read again, in one statement" | A guest value read more than once | G | instance (a narrow syntactic scan); 5:N-2 and 5:N-6 followed |
| 4:C-2 | med | The still-style rewrite expanded shorthands | Read only animation properties | The library's own work ran before the measure | P | instance |
| 4:L-1 | med | `ready` dispatched from inside the embedder's `remove()` or `appendChild()` | Completion moved to a microtask | Dispatch inside the embedder's call | L | instance; 2:L-6's fix had not held |
| 4:M-2 | med | Image loads and violation processing were not charged | `refusedUrl`, `VIEW_MAX_URLS`, `VIEW_URLS_PER_SECOND` | The budget missed the browser's work after the flush | P (E-cpu) | instance; it added `refusedUrl`, and 5:N-3 followed |

### Review round 5, so far (3)

| ID | Sev | Finding | Invariant violated | Class | Recurrence of |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 5:N-1 | med | Unhandled rejections are relayed but not cancelled; Firefox's host page 99% busy | A platform surface outside the chokepoint | E-cpu | 4:M-1 (errors fixed, rejections not); 1:R4-2's listener |
| 5:L-1 | med | Strict mode flushes queued calls at the wrapper's load, not at `ready`; a timed-out call still runs | Queued work released at a point other than the gate | L | CB3 (low, the same symptom); 1:R3-1's fix moved `ready` but not the flush |
| 5:L-2 = N-5 | med | A byte budget smaller than one call answers `BUSY` forever | A cross-field invariant checked per field | C | 4:C-6 (below 1: `BUSY` forever, the same symptom) |

### Recurring lows

| Class | Lows |
| :--- | :--- |
| G | CB2, W4, 5:N-2 (spoofed `ErrorEvent.prototype` getters let errors through), 5:N-6 (`init.method` read twice) |
| L | B5, CB3, CB5, CB7, PD8, 1:R3-2, 2:L-3, 2:L-4, 2:L-6, 2:L-7, 4:L-2, 4:L-3, 5:L-3 (`terminated`/`fileschanged` details not frozen) |
| C | A4, A5, F4, F6, 1:R1-3, 1:R1-4, 1:R3-5, 4:C-5, 4:C-6 |
| B | B6, PA1, 1:R2-4, 4:C-7 (Chromium parts missing from the still list), 4's synthetic-violation URL form, 5:N-3 (`refusedUrl` disagrees with the engines' CSP) |
| D | W3, CB4, W5, 4:L-4, 5:L-4 (a withdrawn write announced with nothing listed), 5:N-4 (a removal of an unregistered file not sent to the view) |
| E-cpu | 2:M-1, 2:M-2, 3:L-4, 4:M-4, 4:M-5 |
| P | 2:M-3, 3:M-5, 4:M-6 |

## Counts

Medium or higher, by class and round:

| Class | Earlier (21) | R1 (9) | R2 (10) | R3 (8) | R4 (5) | R5 so far (3) | Total (56) | Recurring lows |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| E-net | 6 | 1 | 0 | 0 | 0 | 0 | 7 | — |
| E-cpu | 1 | 2 | 0 | 2 | 1 | 1 | 7 | 5 |
| P | 1 | 3 | 2 | 3 | 2 | 0 ¹ | 11 | 3 |
| G | 5 | 1 | 2 | 1 | 1 | 0 | 10 | 4 |
| L | 1 | 0 | 2 | 2 | 1 | 1 | 7 | 13 |
| C | 2 | 0 | 2 | 0 | 0 | 1 | 5 | 9 |
| B | 5 | 1 | 1 | 0 | 0 | 0 | 7 | 6 |
| D | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 |
| O | 0 | 1 | 1 | 0 | 0 | 0 | 2 | — |

¹ Round 5's limits measurement, which is where P findings come from, has not reported yet.

How this differs from research 17. Research 17 split the same findings by what could catch them: our logic, model
versus runtime, or the browser. It put 15 of the earlier 21 under "browser". By invariant, most of those 15 belong to
E-net and B. Both were closed by construction (allowlists and S47), not by measuring browsers one by one.

## Which classes recur, and which were closed

### Recurring: the fixes were per instance

| Class | The chain of instances, each after a fix of the same class |
| :--- | :--- |
| **E-cpu** | 1:R3-3 (logs and RPC bytes) → 3:M-2 (call rate) → 3:C-4 (the view's error-text path) → 4:M-1 (worker `postMessage`, uncancelled errors) → 5:N-1 (uncancelled rejections). In every round from 3 on, a surface no list named. The round-4 comment in `in-sandbox-script.ts` names "the class of M-1" and still fixes only `error`. |
| **P, the view** | 1:R1-1 characters → 2:C-4 running counts → 2:M-3 time per flush → 3:C-2, 3:M-5 measured rendering only → 3:M-1 animations → 4:C-2 rewrite cost → 4:M-2 the browser's work after the flush. Each fix moves the proxy closer to the cost. None can reach it: the true cost is the browser's style, layout, paint, decode and violation work on a thread the view shares. |
| **G, guest-supplied values** | 2:C-3 (a live value measured) → 4:C-1 (read twice) → 5:N-2 (accessor reads on an event), 5:N-6 (read twice). The round-2 scan forbids global lookups and method calls, and round 4's scan forbids "typeof, then read again, in one statement". Neither sees a plain property read that runs a guest-replaced accessor. |
| **L** | Four separate chains: CB3 (low) → 5:L-1 (medium), the same symptom; 2:L-6 → 4:L-1 ("a fix that did not hold"); CB5 → 2:L-4 → 3:L-1 → 4:L-3 (the "no repeat" rule restated four times); 1:R3-1 → 2:C-5 → 2:C-6 → 5:L-1 (what `ready` waits for, and what is released then). |
| **C, not policy** | 2:C-7, 2:L-2 → 4:C-6 (`callLimits` below 1: `BUSY` forever) → 5:L-2 (below one call: `BUSY` forever). |
| **B, new models** | 4:M-2's fix added `refusedUrl`, a second model of CSP source matching → 5:N-3. |
| **D** | W3 → CB4 → 4:L-4 → 5:L-4 and 5:N-4: the list, the announcement and the view are each derived by their own predicate. |

Of round 5's findings, every medium, and three of the six lows and infos that are not documentation (N-3, N-4, L-4), are
in code an earlier fix added or changed:
- N-1 extends S51's relay and is the half of 4:M-1 its fix left;
- L-1 follows S50's `VIEW_READY` gate;
- L-2 follows S57's `callLimits` and 4:C-6;
- N-3 follows 4:M-2's `refusedUrl`;
- N-4 and L-4 follow 4:L-4 and S54's view writes.

This is round 2's and round 4's observation ("new code brings new findings") at the level of classes. A per-instance
fix adds a mechanism, and the mechanism has edges of its own.

### Closed for good by an earlier by-construction change

| Class (part) | Change | Medium-or-higher since |
| :--- | :--- | :--- |
| C, policy strings | S19 grammar, then S47: typed origins, one template per mode | 0 in rounds 1–5. S47's own note lists S7, S14, S16, S19, A3, A5, PD1, PA1 and ST1 before it. The one later finding is 1:R1-4, a low in the origin parser itself. |
| B, CSP fallback | S47: every directive explicit, so no fallback is consulted | 0 |
| B, renderer mechanisms and file types | S38 allowlist renderer, S39 `VIEW_FILE_TYPES`, `load-kinds.ts` | 0 (4:C-7, a low, is a different list) |
| E-net | S43 `WORKER_GLOBALS`, S48 strict default, S38 | 0 in strict and worker mode. Cooperative mode is frozen as limits (S44). |
| G, channel reach | CB1's reversed handshake, captured port primitives | 0 |
| G, intrinsic lookups | 2:C-1's `CAPTURE_POINT` and scan | 0 medium; 5:N-2 (low) slipped through the scan's accessor gap |
| P, RPC measure | 2:C-3's snapshot measure, 3:C-1's frame builders | 0 since 3:C-1 |
| O | Smoke test, baked literal | 0 since 2:C-8 |

**What the closures share.** Each one replaced "remove the bad things we know" with "keep only the listed things".
Each comes with a test that enumerates the domain mechanically: 3000 random configs against the template, a 300-corpus
renderer property, the worker's global object against the list, a source scan. The recurring classes are exactly the
ones with no list:
- the platform's event and message surfaces;
- the fields a library function reads from a guest object;
- the paths into a transition;
- the pairs of config fields;
- what the browser does with rendered content.

### The six hypotheses

| Hypothesis | Verdict |
| :--- | :--- |
| (1) Uncontrolled egress | Confirmed, in two halves. Network egress (E-net) is closed by allowlists. Host-thread egress (E-cpu) recurs in rounds 1, 3, 4 and 5. |
| (2) Values read more than once, and guest-mutable reads | Confirmed for guest-supplied objects and accessors (2:C-3, 4:C-1, 5:N-2, 5:N-6). Closed for global intrinsic lookups. |
| (3) Budgets that measure proxies | Confirmed. The largest class (11). It has converged for RPC, and it has not converged for the view, for an architectural reason. |
| (4) Several transition paths, re-entrant dispatch | Confirmed. 7 mediums and the most lows (13). Three chains repeat a symptom exactly. |
| (5) Scattered config validation | Confirmed but small: 3 mediums in rounds 1–5. One exact repeat (4:C-6 → 5:L-2). |
| (6) The library re-implementing browser policy | Confirmed historically (7 mediums, mostly before S47 and S38) and now largely closed. It recurs, at low severity, exactly where a fix adds a new model (5:N-3). |
| Not in the list | D: one state, several projections (guest writes). Lows only, but in five rounds out of seven. |

## By-construction designs for the recurring classes

Each design below is assessed for what it would have prevented, what it would not, its cost, its migration risk, and
the test that keeps it closed (linked to S61).

### 1. An egress table (E-cpu, and E-net's remaining cases)

**Design.**
- One module (`src/lib/egress.ts`) lists every surface by which guest activity can reach the host page's thread or the
  network. Each row gives:
  - the realm: strict worker, worker-mode worker, view, worker-mode frame, cooperative document;
  - the surface: an event type, a message, a port frame, or browser work started by rendered content;
  - its disposition: absent, cancelled at the source, relayed through a named chokepoint, budgeted, or documented as
    unbounded with the reason;
  - its count, byte and time bounds, and the drop report;
  - its test.
- The bootstraps install their listeners from the table, not by hand.
- `WORKER_GLOBALS` (S43) is already this table for network egress. Extending it to host-thread work is the step this
  design takes.

**Test that keeps it closed (S61.4, made executable).**
- On each engine, an e2e enumerates, in each realm the library runs code in:
  - the `on*` properties of the global's prototype chain;
  - the event types of `Worker.prototype` and `MessagePort.prototype`;
  - the events the platform reports to the console (`error`, `unhandledrejection`, `rejectionhandled`,
    `messageerror`, `securitypolicyviolation`).

  It fails on any surface the table does not list.
- A unit test fails on any row with an empty bound or no test.
- The docs' budgets table (S61.4) is generated from the module.

A new event type in a browser release then fails CI instead of waiting for a review.

**Would have prevented.**
- 4:M-1: the `message` and `error` rows.
- 5:N-1: an `unhandledrejection` row must say "cancelled", and measuring that cell on Firefox shows cancelling does not
  help there.
- 3:C-4: the guest-text rows of the view.
- 1:R4-2: the error rows in every mode.
- B3.
- 1:R3-3 and 3:M-2: a library port's row must state count and bytes.
- The lows 2:M-1, 3:L-4 and 4:M-5: drop reporting is a column.

That is 7 mediums. 4:M-2 and 3:M-1 are prevented only if someone lists "browser work started by kept content", which
cannot be enumerated mechanically. This is research 17's "limits nobody had written down" (R1-1, R3-3, 3:M-2). The
table turns that category into an empty cell, which a test can see.

**Would not prevent.**
- A proxy mismatch inside a row (P).
- Lifecycle findings (L).
- A browser bug in an API the table lists as governed. The allowlist handles that case by keeping the API out.

**Cost and risk.**
- Cost: S–M, 3–5 days. Mostly moving the listeners of `in-sandbox-script.ts` and `in-sandbox-view.ts` behind the
  table, plus the per-engine enumeration spec.
- Risk: low.
- Behaviour change: cancelled rejections no longer reach the worker's devtools console. Cooperative mode keeps its
  console as a documented shared-realm cost.
- Owner decision: a surface that cannot be cancelled at the source (Firefox's rejection reporting, round 5 N-1)
  needs a rule. Either a count budget past which the environment ends with a reason, or a documented limit. A table
  makes that decision visible rather than letting it be implicit.

### 2. One reader for guest values at the boundary (G)

**Design.**
- In each guest realm, one captured helper is the only code that may read a guest-supplied object:
  - `snapshot(value)`: a captured `structuredClone`, then the existing measure;
  - `readEvent(event, fields)`: each listed field read once, through prototype getters captured before guest code.
    For example, `ErrorEvent.prototype`'s `message`, `error` and `filename`, and `PromiseRejectionEvent.prototype`'s
    `reason`.
- Everything else works on the plain record those helpers return. Call arguments, fetch init, events, log arguments
  and thrown values all go through them.

**Test (S61.3, extended).**
- The `CAPTURE_POINT` scan gains one rule: after the capture point, a property read on a listener's parameter or on a
  value received from the guest is an error, except as an argument to the helpers. Such names come from a naming
  convention or an annotation the scan checks.
- A differential property test runs the helpers against the real `structuredClone` (`fc.anything()`), with getters
  and Proxies that answer differently on each read.

This is construction for the helper, and discipline enforced by a scan for the call sites. Only design 7 makes it pure
construction.

**Would have prevented.** 2:C-3, 4:C-1, 1:R4-1 and 3:C-3: 4 mediums. Also the lows 5:N-2, 5:N-6 and W4, and 3:L-2's
host-side half (embedder argument getters read inside a transition).

**Would not prevent.** Intrinsic lookups, which are already closed, and the realm's declaration order (C2, ST4).

**Cost and risk.**
- Cost: M, 3–5 days, across `in-sandbox-script.ts`, the strict prelude in `in-sandbox-view.ts`, `in-sandbox-files.ts`
  and `createBroker`.
- Risk: medium. The code is stringified and must stay self-contained, and which accessors exist differs by engine:
  every getter the helper uses must be captured, and measured, on all three.

### 3. One lifecycle reducer (L)

**Design.**
- `transition(state, event) → { state, effects }` is a pure function.
- Events are the public calls, the platform callbacks and the timers: connect, disconnect, adopt, `setConfig`, `load`,
  `reset`, `terminate`, frame loaded, announced, `VIEW_READY`, worker started or refused, deadline, watchdog, entry
  failed. Each platform event carries its generation, and the reducer drops stale ones, which makes B4's rule
  structural.
- Effects are: build, close, post, start or stop a timer, flush, and dispatch an event with a frozen detail built by
  one constructor.
- A runner applies the effects after the state has settled:
  - effects from a platform callback run in a microtask, never inside the embedder's call (4:L-1, 2:L-6);
  - effects from a public method run at the end of its outermost call, so `terminate()` keeps its documented
    synchronous event;
  - each dispatch re-checks the generation, which is `_notifyThenAct`'s rule moved into the runner.
- **The transition to `ready` is the only one with a flush effect, in every mode.** Today strict mode flushes in
  `_setupStrictChannels` (at the wrapper's load), while the other modes flush in `setupChannel` just before
  `_enterReady`. That difference is 5:L-1.

**Test (S61.2).**
- Round 4's reference model (`lifecycle-model.md`) becomes the reducer's specification, checked with `fc.commands`
  against the pure reducer: thousands of sequences per second, in a unit run.
- A Playwright subset per engine checks only the platform's event ordering.
- A source scan checks that `_state` and `dispatchEvent` appear only in the runner.

**Would have prevented.** 5:L-1, 4:L-1, 2:L-1 and B4 outright, and with design 2, 3:L-2. Partly 3:L-1, 2:C-5 and
1:R3-1, which are a matter of whether the gate is the right event: the reducer makes that a single choice to review.
That is 5 to 6 of the 7 mediums. Also most of the 13 lows: B5, CB3, CB5, 1:R3-2, 2:L-3, 2:L-6, 4:L-2, 4:L-3 and 5:L-3.

**Would not prevent.** A wrong choice of gate per mode. It becomes one line to review instead of a property of several
paths.

**Cost and risk.**
- Cost: L, 1.5–2 weeks with S61.2's suite. The reducer is about 300 lines, and roughly 600–900 lines of `host.ts`
  (2296) would be rewritten.
- Risk: the highest of these designs. The engines differ in timing:
  - a load fired inside `remove()` in Chromium and WebKit;
  - Firefox's adoption prototype (CB7);
  - a build's `terminated` dispatched in a task.

  Mitigation: the existing e2e suite is the differential oracle. Migrate one path at a time behind the same public API.

### 4. One config schema (C)

**Design.**
- A declarative description of every field: type, default, normalisation, clamp, what an invalid value does (dropped,
  default, refused) and its warning.
- Cross-field invariants with their repair and warning. Example: the per-call byte cap is
  min(`RPC_MAX_BYTES`, `maxBytesPerSecond`). A call above it gets the non-retryable `ARGS_NOT_TRANSFERABLE`, never
  `BUSY`, or the budget is clamped up with a warning. That is a semantic choice for the owner.
- Platform-domain types, such as "a delay" (finite and positive, through `long-timer`, or `Infinity`).
- `_applyConfig` becomes `normalize(copy) → { config, warnings, refusal }`. The equal-config check compares normalized
  configs, which are small and acyclic.

**Test (S61.1).**
- A fast-check property over arbitrary configs: the result meets every invariant, `normalize` is idempotent, and the
  warnings are deterministic. One stated invariant: every call that can be carried fits an empty window.
- A golden differential test against today's `_applyConfig` on a corpus of configs, for the migration.

**Would have prevented.** 5:L-2, 2:L-2 and 2:C-7 (3 mediums). Also the lows 4:C-6, 4:C-5, F6, 1:R1-3, A4 and 1:R3-5.
The policy half of C is already closed by S47.

**Cost and risk.** S–M, 2–4 days. Low risk with the differential test.

### 5. Delegating browser decisions, or making the model one-sided (B)

**Facts first.**
- No shipped web API answers "would this URL be refused?" without attempting the load. CSP 1.1 drafted a
  `document.securityPolicy` query interface, but it was dropped and is not implemented.
- A probe load costs exactly the violation processing that 4:M-2 set out to avoid.

So delegation takes three forms:
- **Try it and read the result.** Done already in three places, each by construction: 2:C-6 probes `createPolicy`,
  1:R3-1 uses a probe worker, and B6 builds the `Request`.
- **Let the browser decide, and charge what it reports.** Every observed violation is charged to
  `VIEW_URLS_PER_SECOND`. The owner has approved this for CSS URLs; it is not in the code at `60814b5`. Extend it to
  every violation in the view. Then the bound no longer depends on the library's model being right: a URL the model
  wrongly keeps is still charged when the browser refuses it.
- **Where the library must predict (to avoid the cost), predict one-sidedly.**
  - Keep a URL only if its scheme, host and port equal a listed origin exactly, after the rewrite the policy itself
    demands (`upgrade-insecure-requests`, where the engines agree on it).
  - Drop everything else and report it as now.
  - The remaining disagreements then all go one way: the library drops a URL some engine would have admitted. That is
    a documented functional loss ("write URLs in the exact form you list"), never a refused URL the browser has to
    process.

  The three cases of 5:N-3 fall in that direction. The engine-specific upgrade behaviour (WebKit upgrades every host,
  and the loopback cases) must be measured per engine before the rule is fixed.

**Rule for future fixes.** A fix may add a library model of a browser decision only if:
- the model errs only toward refusing;
- no bound depends on it.

**Would have prevented.** 5:N-3 and round 4's synthetic-violation URL form: report the browser's own violation where
there is one, and synthesize only for dropped URLs. It also makes 4:M-2's bound independent of `refusedUrl`. Past
mediums are mostly closed already.

**Cost and risk.** S, 1–2 days. Low risk. WebKit reports duplicate violations, which must be charged once each or
deduplicated.

### 6. Derived state, one diff (D, lows)

**Design.** The overlay exposes one `diff(before, after)` per path. The list, the `fileswritten` announcement, the
view's `VIEW_WRITE` and the guest's answer are all projections of that diff.

**Test.** A property test (S61.1) over sequences of write, remove, register, unregister and commit. Checks:
- the announced paths are exactly those whose listed entry changed;
- the view's set equals the projection of the store's snapshot plus the overlay.

**Would have prevented.** 4:L-4, 5:L-4 and 5:N-4. **Cost:** S, about a day.

## The structural question

### Where the remaining stream comes from

The rows overlap: 3:C-4, 4:M-1 and 5:N-1, for example, are both a surface outside the chokepoint and work on a shared
thread.

| Architectural choice | Medium-or-higher in rounds 1–5 that stem from it | Can a library remove it? |
| :--- | :--- | :--- |
| **The view on the host page's thread** (Firefox, WebKit, Chromium headless and Android WebView) | 11 of 35 (31%): 1:R1-1, 1:R1-2, 1:avail, 2:C-4, 3:M-1, 3:C-2, 3:C-4, 4:M-1, 4:C-2, 4:M-2, 5:N-1. Most of the earlier 21 predate the question, apart from ST2 and S42. | No (research 16). It can be narrowed by allowing only features whose cost is bounded (the S38 and `allowAnimations: false` pattern, and S42's CSS allowlist through the browser's own parser as the next one), and by an honest statement of the bound. |
| **Library code in a guest realm** (the strict worker's prelude, relay and broker) | 7 of 35 (20%): 1:R4-1, 2:C-1, 2:C-2, 2:C-3, 3:C-3, 4:C-1 and 3:C-1's sender half; plus the lows 5:N-2 and 5:N-6. | Yes, partly, with design 7 below. |
| **Lifecycle spread over many paths** (about 40 lines in `host.ts` that change state, flush or dispatch) | 6 of 35 (17%) | Yes: design 3. |
| **Cooperative mode's shared realm** | 1–2 of 35 (1:R2-2, part of 1:R4-2). In the earlier reviews it was about 10 of 21. | Already done: S48 made strict the default and froze cooperative mode's limits. This choice no longer drives the stream. |
| **Re-deriving browser policy** | 2 of 35 mediums (1:R3-1, 2:C-6: host-page inheritance) and 3 lows (4:C-7, 4's synthetic URL, 5:N-3) | Mostly done (S47, S38). Design 5 and the rule cover what is left. |
| **The number of channels** | See below. | — |

### Would one multiplexed, budgeted port per environment remove whole classes?

The library already has one logic port carrying `LOG`, RPC, `VIOLATION`, `RESIZE` and `PONG`. The view port carries
the view's own frames. The findings attributable to "more than one library channel" are:
- 3:C-4: guest text on the view port;
- 3:C-1: part of a frame measured;
- 1:R3-3 and 3:M-2: a channel without a budget;
- B3.

That is about 5 of 56 (9%). The rest of E-cpu came through **platform** surfaces that no port consolidation reaches:
- the worker's own `postMessage`;
- the `Worker` object's error events;
- console reporting of rejections;
- violation processing;
- image decoding;
- animations.

So the consolidation that matters is not of the library's ports, but of where guest-generated platform events land.

### 7. A trusted relay worker (architectural)

**Design.**
- In strict mode (and worker mode, or strict mode after S49), the view spawns a library-only relay worker.
- The relay worker spawns the guest's worker as a nested worker. It holds the guest's only port.
- The guest's `Worker` object, with its `error` events, messages and possibly rejection reporting, then lives on the
  relay's thread, not the host page's.
- The relay measures what it received: deserialized plain data in a trusted realm, so no getter can lie.
- It budgets every guest frame (calls, logs, renders by bytes and rate), and forwards bounded frames to the host and
  the view.

The guest-realm relay and broker code becomes functional only. A guest that subverts it loses its own logs and calls,
but cannot exceed a budget.

**Would have prevented** (rounds 1–5, strict and worker mode): 2:C-1, 2:C-2, 2:C-3, 3:C-1, 3:M-2 (bypass-proof),
3:C-4, 4:M-1, 4:C-1, 1:R3-3's worker half, and 5:N-2. 5:N-1 must be measured: where Firefox does its rejection
reporting for a nested worker is unknown. About 9–10 of 35 (26–29%).

**Would not prevent.**
- The view's rendering cost (the rest of P).
- L and C.
- Cooperative mode.

**Cost and risk.**
- Cost: L, 2–3 weeks.
- Must be probed first, like research 15:
  - nested blob workers inheriting the view's policy on all three engines;
  - WebKit under COEP (1:R3-1's residual already shows WebKit refuses the view's blob worker there);
  - the memory of one more worker per sandbox;
  - the latency of one more hop;
  - error muting after the source URL is revoked (C1, WebKit's "Script error.");
  - host-page busy under 4:M-1's and 5:N-1's floods with the relay in place.
- It would make design 2's guest-side discipline unnecessary as a security property. So the probe should come before
  investing in design 2 beyond round 5's own fixes.

## Recommendation

### In round 5's fix batch: each fix as the first slice of its class's design

1. **N-1.** Start `egress.ts` with the worker's and view's event rows, cancel rejections after relaying them in every
   mode that has a port, and add the enumeration test (unit for completeness, e2e per engine for the surfaces). For
   Firefox, where cancelling does not help, the owner decides: a count budget that ends the environment past it, or a
   documented limit. Also measure `rejectionhandled`, which the worker keeps (`onrejectionhandled` is in
   `WORKER_GLOBALS`) and which no review has measured.
2. **L-1.** Move every flush to `_enterReady`, in every mode, and remove it from `setupChannel` and
   `_setupStrictChannels`. Add a model-style unit property: a call that settles before `ready` is never posted, in any
   mode. This is design 3's gate without the rest of the reducer.
3. **L-2 = N-5.** The schema's first cross-field invariant (derived per-call byte cap, a non-retryable code or a
   clamp, one warning), with a fast-check property over `callLimits`. The owner chooses which.
4. **N-2, N-6.** Capture the `ErrorEvent` and `PromiseRejectionEvent` getters before guest code, add one `readEvent`
   helper, and extend the scan to property reads on listener parameters. This is design 2's first slice.
5. **N-3.** One-sided matching plus charging every observed violation (design 5). The owner has already approved the
   violation charge for CSS URLs.
6. **N-4, L-4.** One diff for the guest-write projections (design 6).
7. **L-3.** One detail constructor that freezes; a scan that every `dispatchEvent` uses it.
8. **N-7.** Docs.

Cost: about 4–6 days beyond the per-instance fixes the batch would need anyway.

### After round 5, in this order

1. **The lifecycle reducer with S61.2's suite** (L, 1.5–2 weeks). L is the class with the most findings in total
   counting lows (20), and with three exact repeats. The reducer also makes S61.2 cheap.
2. **A probe for the relay worker** (a research note, 2–3 days). Adopt it (2–3 weeks) only if nested workers, COEP and
   the error semantics hold on all three engines. If it is not adopted, complete design 2 (3–5 days).
3. **The full config schema** (2–4 days, S61.1).
4. **The view's cost.** An owner decision on S42's CSS allowlist through the browser's parser, or an explicit
   statement that the view's bound is the long-run average plus the per-render caps, and that a single operation and
   browser work on kept content are bounded only by those caps.
5. **A rule for every future fix.** Each fix names its class and changes that class's chokepoint, or adds a row or a
   case to the class's structural test. A fix that adds a new model or a new path says why no list covers it.

### The expected effect on review rounds, and the uncertainty

- **The round-5 batch.** It should stop the exact repeats in E-cpu (for enumerable surfaces), L (the flush gate), C
  (`callLimits`) and B (`refusedUrl`). Expect round 6 to still find 2–4 mediums, mostly P from the limits measurement
  and L from paths the gate does not cover yet.
- **After the reducer and design 2 (or design 7).** L and G should fall to about 0–1 medium a round. The stream that
  remains would be dominated by the view's cost on a shared thread (P) and by browser-specific behaviour.
- **Two clean rounds.** Reaching them then depends less on code than on the stopping rule's split: documented limits
  do not reset the count. The view's bound must be stated in a form that new measurements fall inside. Today they keep
  landing outside it, because each is a new proxy gap.
- **Uncertainty.**
  - The classification is one reviewer's judgement, and some findings belong to two classes.
  - The prevention counts are counterfactual, not experiments.
  - Round 5 is partial (M is missing).
  - The relay worker's benefit for 5:N-1 is unmeasured.
  - The estimates of cost are for one person who knows the code.

## Round 5's limits measurement

The measurement reported after the tables above. Its four medium-or-higher findings fall into the classes already named:

| Finding | Severity | Class | Invariant violated |
| :--- | :--- | :--- | :--- |
| M-1: with `allowAnimations: false`, replacing about 37,000 elements froze Firefox's host page for 22–25 s; the `*::first-letter` rule of the library's own still stylesheet took 20 s alone | high | P | The library's own mitigation adds browser work that no budget and no test measures. Round 4's C-2 was the same invariant, so this sub-class recurs too. |
| M-2: the 1000 ms debt cap lets an operation that costs 7.5 s (Chromium layout) repeat every few seconds; host 53% busy | medium | P | A budget that charges a capped proxy of the cost, not the cost. |
| M-3: CSS `url()` to an allowed origin is not counted by the URL budget (Firefox 1400 requests per second) | medium | E-net / P | A load the renderer cannot see is not budgeted: only what the renderer parses is counted. |
| M-4: a long allowed-image flood within the URL budget ends in a 13–28 s WebKit stall | medium | P | A per-second rate stands in for a cumulative cost (memory, cache). |

The measurement also found that `allowAnimations: false` makes every render 3–4 times as expensive in Chromium and
WebKit (`*::scroll-button(*)` alone 3.5 times in Chromium; low), the same sub-class as M-1.

This confirms the recommendation, with two additions:
- **Observe and charge loads, not only violations (design 5).** Every load the view's document makes is reported by the
  platform's resource timing in all three engines, CSS-borne ones included. Charging every observed load and every
  violation to the URL budget covers allowed and refused URLs alike without parsing CSS.
- **Measure the library's own mitigations.** The still stylesheet is generated per engine for the pseudo-elements that
  can animate on the allowed elements, and an e2e times a large replacement with it on and off on every engine. A
  mitigation whose cost is not measured is a new proxy.

Round 5's totals: 1 high and 6 medium in our code, all in code an earlier per-instance fix added or changed.
