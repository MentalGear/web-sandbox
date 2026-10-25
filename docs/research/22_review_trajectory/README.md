# 22. Review trajectory: is the finding curve bending?

Every review round since 2026-10-14, counted by what each finding could do, and the coordinator's evaluation of the
approach after each board pass. The data is [`rounds.json`](rounds.json) (one object per round, with the basis of every
count); the capabilities removed because of a finding are in [`clipped-capabilities.md`](clipped-capabilities.md). The
board's rule and its passes are backlog [S74](../../BACKLOG.md#s74); the reports are in
[the archive](../../archive/reviews/).

**How the counts are made.**
- A *data* finding leaks or can manipulate data, credentials or host state across the policy (the board's rule of
  2026-10-21, applied to the earlier rounds from their finding text). *Availability* findings cost time or memory only.
  *No data effect* covers docs, tests and correctness.
- *Reaching strict* counts the data findings that reach strict mode at its default configuration or with `origins` or
  `fetchBridge`. Strict mode became the default on 2026-10-15 (S48), so the four rounds before it have no such count.
- The board passes (BD1 to BD4) had verifiers and added a docs reviewer, a test reviewer and a newcomer, so their low
  counts are higher and not comparable with R1 to R5. AR and BR used split ratings; the first-listed half is counted.

## The rounds

| Round | Date | Commit | Reviewers | High | Medium | Low | Data | Availability | No data effect | Data reaching strict |
| :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| AR, adversarial review | 2026-10-14 | `ca2110c` | 3 | 0 | 5 | 12 | 6 | 2 | 15 | n/a |
| FR, focused review | 2026-10-14 | `affe25e` | not stated | 1 | 2 | 3 | 2 | 2 | 8 | n/a |
| BR, broad review | 2026-10-14 | `12d7924` | 4 | 2 | 6 | 7 | 13 | 3 | 9 | n/a |
| VR, verification | 2026-10-14 | `8421d70` | 5 | 1 | 1 | 1 | 5 | 0 | 10 | n/a |
| R1 | 2026-10-15 | `5ede7ba` | 4 | 0 | 9 | 15 | 1 | 4 | 27 | 0 |
| R2 | 2026-10-15 | `31b8f0d` | 3 | 2 | 8 | 11 | 0 | 6 | 21 | 0 |
| R3 | 2026-10-18 | `16c545b` | 3 | 2 | 6 | 4 | 0 | 7 | 11 | 0 |
| R4 | 2026-10-18 | `c7672bb` | 3 | 0 | 5 | 7 | 0 | 5 | 15 | 0 |
| R5 | 2026-10-19 | `60814b5` | 3 | 1 | 6 | 7 | 0 | 6 | 10 | 0 |
| BD1, board pass 1 | 2026-10-21 | `9141e4e` | 6 + 3 verifiers | 4 | 5 | 43 | 3 | 5 | 45 | 2 |
| BD2, board pass 2 | 2026-10-21 | `6d727a8` | 6 + 3 verifiers | 3 | 9 | 17 | 5 | 2 | 22 | 3 |
| BD3, board pass 3 | 2026-10-23 | `be0a34a` | 6 + 2 verifiers | 4 | 6 | 28 | 5 | 1 | 32 | 4 |
| BD4, board pass 4 | 2026-10-24 | `46eb358` | 6 + 5 verifiers | 3 | 7 | 14 | 5 | 3 | 16 | 5 |

There was no critical finding in any round.

*Reaching strict* for BD4 counts the five confirmed data findings: ISO-1, ISO-3, CHL-2, DOC-2 and DOC-3. Each was reproduced
by its reviewer and by a verifier on the three engines, and each needs an opt-in (`origins.connect` or
`origins.withoutCors`). CHL-1 (confirmed, medium) is not counted: no destination is reached that the guest could not reach
already, so it is a uniformity failure, not a leak; NEW-2 (a docs example whose sink is the embedder's code) has no
reproduction. Counted as data, they would make 7. The BD4 row has its duplicates (DOC-1, DOC-4) and its refuted finding
(LIM-2) taken out: 27 findings as filed, 24 after the verdicts.

```mermaid
xychart-beta
    title "Data findings reaching strict mode, per round"
    x-axis [R1, R2, R3, R4, R5, BD1, BD2, BD3, BD4]
    y-axis "findings" 0 --> 6
    bar [0, 0, 0, 0, 0, 2, 3, 4, 5]
```

## What the curve says

**The rise is method first.** Data findings fell to zero across R2 to R5, which probed the library through the test
harness page, where the host page is plain. The board passes added a realistic host page (a strict CSP, Trusted Types,
cookies on sibling subdomains, consent scripts, frames) and a newcomer who embeds from the docs alone. Every data finding
since then is about the host page's context reaching the sandbox (classes A and E of
[research 18](../18_finding_classes/README.md)): its CSP, its base URL and its cookies.

**Then fix-induced.** The three confirmed highs of BD3 are in code written to fix BD2:

| Finding | Code | Added | What that code did |
| :--- | :--- | :--- | :--- |
| BD3:CHL-1 | `src/lib/host-csp.ts` | 2026-10-23 | Read the host page's `connect-src` with a decoy request; a moved element left the read without an answer, and the build kept every listed origin. |
| BD3:ISO-1 | `src/lib/host-site.ts` | 2026-10-22 | Learned the host's registrable domain by writing a test cookie; a host that holds back cookie writes made it guess, and the guess admitted siblings. |
| BD3:ISO-2 | the same-site decision in `src/host.ts` | 2026-10-22 | Took the host origin from `location`, which reads `'null'` in a same-origin `srcdoc`, so nothing counted as same-site. |

Each of them predicted something the browser decides (which policy applies, which cookies a request carries) from host
page state the library cannot verify, and admitted the origin when the prediction failed. A realistic-host review finds
the edges of every such predictor, and a patch on an edge adds more prediction code. The data count reaching strict went
2, 3, 4 while the core (the worker, the request gate, the view's allowlists, the environment check, the fetch bridge)
was found sound by every reviewer of BD2 and BD3.

**The response (2026-10-24).** Replace a prediction with a rule that reads only what the browser guarantees and refuses
when it cannot decide, and delete the predictor: the host page's site from `self.origin` by one rule that can only
over-refuse, and a host-policy read that never answers "absent" (both in #71). Cookies on the strict view's loads go the
same way: the renderer forces `crossorigin="anonymous"`, so the browser omits them
([research 21](../21_crossorigin_loads/README.md)).

**Pass 4 found the response incomplete, and in the same places.** The count reaching strict rose to 5, and the three
highs sit in #71's code and its neighbours:

| Finding | Code | Added | What that code did |
| :--- | :--- | :--- | :--- |
| BD4:ISO-1, BD4:ISO-3 | `src/lib/host-site.ts` | #71 | Decided the host page's site from the realm's `self.origin`. An opaque origin meant "no site", so every entry was kept; and the browser decides a request's site from the top-level document (WebKit) or an ancestor, so a host page framed by another site, or sandboxed, kept entries on a site that WebKit sends Lax and Strict cookies to. |
| BD4:CHL-2 | `src/lib/host-csp.ts` | #71 | Read the host page's `connect-src` through a decoy within 2 s and cached "cannot be read" for the page; a stall of the host's thread made every later build keep its connect lists. |
| BD4:DOC-2, BD4:DOC-3 | `origins.withoutCors` | #73 | A per-origin exception to the forced `crossorigin`. It was approved while the guest could not read a load's result; the readback of #74 made it a credentialed read, and a redirect or an imported sheet carried the cookie to the other listed origins. |

The pattern is the one of pass 3: a prediction of a browser decision (which site, which policy, which cookie) from state
the library cannot verify, plus an exception to a construction that held. This time the response removes the predictors
instead of correcting them (2026-10-24): strict mode has no cookie carrier, no `WebSocket` and no `origins.withoutCors`
(#75); the host page's policy comes only from `hostContentSecurityPolicy` and the read is deleted (#76); the same-site rule
refuses whenever it cannot decide, and counts every ancestor's site (#78). And the board's scope changes: sealed mode, strict
with no network, becomes the default and the scope (D5 of [research 24](../24_sealed_mode/README.md)), so a network opt-in
of strict is no longer where a clean pass is decided.

## What capability it has cost

48 capabilities were removed or restricted because of a finding ([the table](clipped-capabilities.md)). What a UI author
notices most: the strict view renders an allowlist (no `canvas`, SVG filters or animation, popovers or `contenteditable`;
links and forms navigate nowhere); CSS animations and transitions and autoplay are opt-ins; the network is typed exact
origins with credentials omitted; the worker keeps an allowlist of globals.

The fixes of BD3 cost network convenience, not UI: listed image, media and style origins must answer CORS; other sites
under a multi-label public suffix (two `github.io` sites) are refused; network `url()` in guest CSS is dropped in strict
mode. The fixes of BD4 cost more of it: strict mode opens no `WebSocket` and has no per-origin way around CORS for a view
load, and an embedder that lists `connect` or bridge origins passes its page's policy as text. The finding classes left
open (the value boundary, re-entry, the shared thread) are internal and cost no capability.

**Strict mode and a modern UI.** It carries forms, dashboards, app shells and settings flows with CSS transitions (the
`allowAnimations` opt-in), and, since pointer, wheel, scroll and focus events reach the worker (#74,
[research 23](../23_view_input/README.md)), drag-and-drop, gestures, custom sliders and virtual scrolling, all of it guest
code in the worker and none in the view.

## The evaluation rule

After every board pass the coordinator updates this note and S74, and changes the approach before the next pass when
either holds:
- the data findings reaching strict do not fall for two passes in a row;
- a pass's data findings sit in code that the previous pass's fixes added.

"Change the approach" means shrinking the surface the finding came from (deleting a predictor, constructing a property
instead of checking it, or the served-document mode, which removes most of the host-adaptation layer) rather than
patching it.

## Evaluations

| After | Data reaching strict | Rule triggered | Decision |
| :--- | ---: | :--- | :--- |
| BD3 (2026-10-24) | 4 (up from 3) | both: the count rose a second time, and all three highs sit in code BD2's fixes added | Delete the two predictors (#71); cookies on view loads by `crossorigin="anonymous"`; pass 4 reviews the result. If pass 4 still finds host-adaptation data findings, take up the served-document mode. |
| BD4 (2026-10-24) | 5 (up from 4) | both again: the count rose a third time, and the three highs (BD4:ISO-1, BD4:ISO-3, BD4:CHL-2) sit in #71's code (`host-site.ts`, `host-csp.ts`); BD4:DOC-2 and BD4:DOC-3 sit in the exception of #73 | Owner, 2026-10-24: sealed mode becomes the default and the board's scope, and strict's network findings no longer block a clean pass (D5). The predictors are deleted: the cookie carriers (#75), the policy read (#76) and the same-site rule's guesses (#78). Pass 5 reviews sealed mode at its default. |
