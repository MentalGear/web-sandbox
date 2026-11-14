# Research 27: raw results

The output of each browser run of [research 27](../README.md), one file per question, part and engine
(`<q>[-<parts>]-<engine>.txt`), written by `run.mjs`. Each line is a tag and one JSON object: `<q>.run` (engine, version,
date, load average), then one line per case. `bun docs/research/27_served_document_headerless/summarize.mjs [prefix]`
prints the compact view the README's tables were read from.

Superseded parts, kept as written: the `headers` part of `q5-chromium.txt` (one URL for every case, so a cached response
answered the later ones; `q5-headers-chromium.txt` replaces it) and the `referrer` part of `q4-chromium.txt` (a
fragment-only navigation kept the first case's frames; `q4-referrer-chromium.txt` replaces it).
