/// <reference types="bun" />
import { mkdir, rm } from "fs/promises";
import { join } from "path";

const OUT_DIR = "dist";
const SRC_DIR = "src";

async function build() {
    console.log("Building Web Sandbox...");

    // Clean
    await rm(OUT_DIR, { recursive: true, force: true });
    await mkdir(OUT_DIR, { recursive: true });

    // Build Host Libs
    await Bun.build({
        entrypoints: [join(SRC_DIR, "host.ts"), join(SRC_DIR, "devtools.ts")],
        outdir: OUT_DIR,
        target: "browser",
        minify: true,
    });

    // The playground is built separately with `bun run build` (vite build).
}

build().catch(console.error);
