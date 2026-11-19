# Research 26: raw results

The output behind every number of [the note](../README.md), one file per probe and engine, as `run.mjs` wrote it: one
tagged JSON line per result (`q1`, `q2.watchdog`, `q2.cpu`, `q3`, `q4`, `q5`, `q6.reach`, `q6.control`, `q6.boundary`),
each with the engine's version, the load average and the time. `summarize.mjs` prints the tables' figures from them.

| File | What |
| :--- | :--- |
| `q1-<engine>.txt` | Q1: both builds under each host and view policy |
| `q2-<engine>-watchdog.txt` | Q2: each operation's duration, the watchdog's latency, the turns between two polls |
| `q2-<engine>-cpu*.txt` | Q2: the browser's CPU in 100 ms windows after `terminate()` and after the frame's removal |
| `q3-<engine>.txt` | Q3: allocation past each limit, what the content, the interpreter and the host page saw |
| `q4-<engine>.txt` | Q4: startup and speed, 5 runs per build |
| `q5-firefox-interp-interp-fresh.txt` | Q5: the host page's busy share during the flood inside the interpreter |
| `q6-<engine>.txt` | Q6: the interpreter's globals, the policy control, the boundary |
| `import-calls-bun.txt` | Q2: calls into the glue's JavaScript functions per operation (Bun) |
| `poll-gap-bun.txt` | Q2: the watchdog against a loop of heavy operations (Bun, bounded at 60 s from outside) |
| `sizes.json` | Q4: the sizes of the built files, raw, gzip and brotli |

The Q2 `cpu` lines carry the CPU windows raw (`afterStop`, `afterRemoval`) and the probe's first idle reading
(`idleMsAfterStop`, under 0.3 cores); the note's "stopped at" is recomputed from the windows by `summarize.mjs` (no
window from then on reaching 0.85 cores), because single windows of Firefox's own background work exceed 0.3.
