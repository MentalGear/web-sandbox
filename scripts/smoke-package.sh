#!/usr/bin/env bash
# Packs the library with bun, installs the tarball into a throwaway consumer project, and checks
# that the public entry point resolves, type-checks and bundles (backlog D1).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$root"
bun run build:lib >/dev/null
bun pm pack --destination "$work" --quiet >/dev/null
tarball="$(ls "$work"/*.tgz)"

mkdir "$work/consumer"
cd "$work/consumer"
cat > package.json <<'JSON'
{ "name": "consumer", "private": true, "type": "module" }
JSON
bun add "$tarball" >/dev/null
bun add -d typescript >/dev/null

cat > consumer.ts <<'TS'
import { defineWebSandbox, WebSandbox, SAFE_CAPABILITIES, type SandboxConfig } from 'web-sandbox';

const config: Partial<SandboxConfig> = { capabilities: ['allow-scripts'], unsafeCapabilities: ['fullscreen'] };
const element: typeof WebSandbox = defineWebSandbox('consumer-sandbox');
console.log(element.name, SAFE_CAPABILITIES.length, config);
TS
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "ESNext", "module": "Preserve", "moduleResolution": "bundler", "lib": ["ESNext", "DOM"], "strict": true, "noEmit": true, "skipLibCheck": false }, "include": ["consumer.ts"] }
JSON

bunx tsc -p .
bun build consumer.ts --target browser --outdir out >/dev/null
echo "package smoke test passed: $(basename "$tarball")"
