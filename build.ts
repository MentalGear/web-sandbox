/// <reference types="bun" />
import { mkdir, rm } from "fs/promises";
import { join } from "path";

const OUT_DIR = "dist";
const SRC_DIR = "src";
const VFS_DIR = "src/virtual-files";

async function build() {
    console.log("Building Web Sandbox...");

    // Clean
    await rm(OUT_DIR, { recursive: true, force: true });
    await mkdir(OUT_DIR, { recursive: true });
    await mkdir(join(OUT_DIR, "virtual-files"), { recursive: true });

    // Build Host Libs
    await Bun.build({
        entrypoints: [join(SRC_DIR, "host.ts"), join(SRC_DIR, "devtools.ts")],
        outdir: OUT_DIR,
        target: "browser",
        minify: true,
    });

    // Build VFS SW
    await Bun.build({
        entrypoints: [join(VFS_DIR, "sw.ts")],
        outdir: join(OUT_DIR, "virtual-files"),
        target: "browser",
        minify: true,
    });

    // Copy HTML Assets
    const hubFile = Bun.file(join(VFS_DIR, "hub.html"));
    await Bun.write(join(OUT_DIR, "virtual-files/hub.html"), hubFile);

    // The playground is built separately with `bun run build` (vite build).
}

build().catch(console.error);
