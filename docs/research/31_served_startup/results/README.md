# Research 31: raw results

The output of each browser run of [research 31](../README.md), one file per probe and engine (`<probe>-<engine>.txt`),
written by `run.mjs`. Each line is a tag and one JSON object: `<probe>.run` (engine, version, date, load average), then
one line per case. `summarize.mjs <file>` prints the compact view the tables were read from, `tables.mjs <set>` Q3's
tables, and `compare-ways.mjs <set>` Q4's twelve ways against research 28's results.

| Set | Engines | What it is |
| :--- | :--- | :--- |
| [`2026-11-18_pw-1.65.1/`](2026-11-18_pw-1.65.1/) | Playwright 1.65.1: Chromium 159.0.8154.6 (headless shell), Firefox 159.0, WebKit 27.2 | The set of the README's Q1 to Q5. `q1` the start-up order, its failure modes and its cost; `q1b` the digest under a non-secure host page; `q2` the gates' mutants; `q3` the policy check under headers; `q3b` which documents' violations are reported; `q4` forms and extra flags; `q4w` and `q4g` the twelve ways (static and guarded file); `q5` a page that frames the host page. The runs' UTC timestamps fall on 2026-11-19. |
| [`2026-11-19_pw-1.65.1/`](2026-11-19_pw-1.65.1/) | the same | The set of the README's Q6 and Q7. `q6` the refused canaries under 57 headers, their positive control and their cost (`tables-q6.mjs <set>` prints Q6's tables); `q7` the view speaking first, its forgeries, its race and its cost against Q1's order. |
