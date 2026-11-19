/**
 * Public entry point of the package, as published: the default build, which has sealed mode alone (ADR-009). Its module
 * graph holds no module of the network modes (src/lib/build-modules.ts; test/unit/default-build.test.ts), so their code
 * is not in dist/index.js. The build with them has its own entry, network.ts (`WEB_SANDBOX_NETWORK_MODES=1 bun run
 * build:lib`).
 * Importing it registers nothing: call defineWebSandbox() with the URL of the served file (and optionally a tag name).
 */
export * from "./sealed";
