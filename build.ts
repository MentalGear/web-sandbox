import { mkdir, rm } from "fs/promises";
import { join } from "path";

const OUT_DIR = "dist";
const SRC_DIR = "src";
const VFS_DIR = "src/virtual-files";

async function build() {
    console.log("Building Lofi Web Sandbox...");

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

    // Copy Playground (as demo)
    await mkdir(join(OUT_DIR, "playground"), { recursive: true });
    const demoFile = Bun.file("playground/vfs-demo.html");
    const securityFile = Bun.file("playground/security.html");

    // We need to patch the HTMLs to point to dist files?
    // vfs-demo.html uses /src/host.ts. In dist it will be /host.js
    let demoHtml = await demoFile.text();
    demoHtml = demoHtml.replace(/\/src\/host\.ts/g, "/host.js");
    demoHtml = demoHtml.replace(/\/src\/devtools\.ts/g, "/devtools.js");
    demoHtml = demoHtml.replace(/\/src\/virtual-files/g, "/virtual-files"); // Use built VFS path

    await Bun.write(join(OUT_DIR, "index.html"), demoHtml);
    await Bun.write(join(OUT_DIR, "playground/security.html"), securityFile); // This one imports src too?

    // Also copy project assets
    await mkdir(join(OUT_DIR, "project"), { recursive: true });
    // Assuming project/ exists
    // cp -r playground/project/* dist/project/
}

build().catch(console.error);
