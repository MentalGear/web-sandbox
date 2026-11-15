# Research 30: raw results

The output of each browser run of [research 30](../README.md), one JSON object per line: a `run` line (engine, version,
headed or headless, date, repetitions), then one `result` line per run (each a fresh browser context and page), or an
`error` line. A result has the host page's own reports (each `window.open` call with `navigator.userActivation` before
and after it, and the request's activation state), the hits the recorder server saw after each click, and the tabs the
context's `page` event counted. `summary.txt` is `node docs/research/30_links_popup/summarize.mjs results/*.jsonl` over
the files below; the README's tables were read from it.

| File | Script | What it is |
| :--- | :--- | :--- |
| `headless-<engine>.jsonl` (`chromium`, `firefox`, `webkit`, `shell`) | `probe.mjs` | Variants 1 to 6 (the delays of 5 up to 6 s), 5 runs each. `chromium` is the full build in new headless mode, `shell` the headless shell. |
| `headless-fine-<engine>.jsonl` | `probe.mjs --reps=10 --variants=5@4000,5@4500,5@5000,5@5500` | Where the activation expires, 10 runs per delay. |
| `headless-race4-<engine>.jsonl`, `headless-race-<engine>.jsonl` | `probe.mjs --tail=500` | Variant 4 (100 runs), variants 2, 3, 5@10 and 5@50 (50 runs each): the open in the request's own task or 10 and 50 ms later. |
| `headless-library.jsonl` | `run-library.mjs` | Variant 7, the library, 5 runs per variant on `chromium`, `firefox`, `webkit` and `chromium-shell`. |
| `headless-library-guest-asks.jsonl` | `run-library.mjs --variants=8,9,10,9late` | The guest asks by itself, with no click, after a click on the host page, after a click in the view off the button, and after a click 5.5 s old. |
| `headed-probe.jsonl`, `headed-library.jsonl`, `headed-library-guest-asks.jsonl` | the same, under `xvfb-run -a` with `--headed` | Headed Chromium and Firefox (WebKit: the probe only; its GTK build, headed). |
