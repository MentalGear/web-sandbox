# Research 27: raw results

The output of each browser run of [research 27](../README.md), one folder per set of runs, named by its date and the
Playwright version it ran on, one file per question, part and engine (`<q>[-<parts>]-<engine>.txt`), written by `run.mjs`.
Each line is a tag and one JSON object: `<q>.run` (engine, version, date, load average), then one line per case.
`bun docs/research/27_served_document_headerless/summarize.mjs <set> [prefix]` prints the compact view the README's tables
were read from.

| Set | Engines | What it is |
| :--- | :--- | :--- |
| [`2026-11-15_pw-1.65.1/`](2026-11-15_pw-1.65.1/) | Playwright 1.65.1: Chromium 159.0.8154.6 (headless shell), Firefox 159.0, WebKit 27.2 | The set the README's tables state: one run of every probe and engine. |
| `2026-11-15_pw-1.65.1-rerun1/`, `-rerun2/`, `-rerun3/` | the same | Three more runs of q1 to q4 on every engine and of q6 on Firefox and WebKit, to tell an engine change from variation between runs. |
| [`2026-11-15_pw-1.65.1-style-variation/`](2026-11-15_pw-1.65.1-style-variation/) | Firefox 159.0 | The runs of q3 and q1 before the style readings were fixed (`*-before-fix*`), with a debug run of q3: the intermittent "style refused" and "unmeasured" cells and their cause (the README's Method section). |
| [`2026-11-14_pw-1.58.1/`](2026-11-14_pw-1.58.1/) | Playwright 1.58.1: Chromium 145.0.7632.6 (headless shell), Firefox 146.0.1, WebKit 26.0 | The runs the note was first written from, kept as written. Its style readings used the earlier probe; no cell of it shows the symptom the variation set documents (the README's Method section). |

Superseded parts of the 2026-11-14 set, kept as written: the `headers` part of `q5-chromium.txt` (one URL for every case,
so a cached response answered the later ones; `q5-headers-chromium.txt` replaces it) and the `referrer` part of
`q4-chromium.txt` (a fragment-only navigation kept the first case's frames; `q4-referrer-chromium.txt` replaces it).
The 2026-11-15 sets have one file per probe and engine, with every part in it.
