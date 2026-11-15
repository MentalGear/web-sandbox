# Research 28: raw results

The output of each browser run of [research 28](../README.md), one folder per set of runs, named by its date and the
Playwright version it ran on, one file per probe and engine (`<probe>-<engine>.txt`), written by `run.mjs`. Each line is
a tag and one JSON object: `<probe>.run` (engine, version, date, load average), then one line per case.
`bun docs/research/28_served_topology/summarize.mjs <set> q1` prints the compact view of a Q1 file the README's tables
were read from.

| Set | Engines | What it is |
| :--- | :--- | :--- |
| [`2026-11-15_pw-1.65.1/`](2026-11-15_pw-1.65.1/) | Playwright 1.65.1: Chromium 159.0.8154.6 (headless shell; `q4b-chromium-full.txt` the full build), Firefox 159.0, WebKit 27.2 | The set the README's tables state. `q1` the trampoline, `q4a` the same with the file on another site, `q1s` the static file, `q1g` the guarded static file, `q2` the constant policy, `q3` the channel, `q4p` the cross-site file's policy, `q4b` placement, `q6` the spike, `q7` the gates, `q1w-*` the WebKit triage. |
| [`2026-11-15_pw-1.65.1-q1-one-browser/`](2026-11-15_pw-1.65.1-q1-one-browser/) | the same | The first runs of `q1`, every case of an engine in one browser; on WebKit the sandboxed-popup case closed the browser and every case after it failed (`q1-webkit-first.txt`, `q1-webkit.txt`). Kept as written; the probe now runs each part in a browser of its own. |
| [`2026-11-15_pw-1.65.1-superseded/`](2026-11-15_pw-1.65.1-superseded/) | the same | `q7` before its cookie gate read a result (WebKit's opaque `srcdoc` does not throw on `document.cookie`, so the gate failed the correct file there), and `q1g` before its cases waited for `commit`: the guarded file stops its own load, so a top-level or popup F never fired `load` (Chromium, Firefox: those cases timed out) and, on WebKit, neither did the page that frames it (`q1g-webkit.txt` and its rerun `q1g-webkit-framed-load.txt`: the framed wrong-way cases timed out). Kept as written. |
