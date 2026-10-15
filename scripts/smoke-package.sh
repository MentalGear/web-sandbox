#!/usr/bin/env bash
# Packs the library with bun, checks that the tarball holds exactly the files the package is (broad review PD9),
# installs it into a throwaway consumer project, and checks that the public entry point resolves, type-checks and
# bundles (backlog D1).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$root"
bun run build:lib >/dev/null
bun pm pack --destination "$work" --quiet >/dev/null
tarball="$(ls "$work"/*.tgz)"

# The manifest, exactly: package.json, the README and the notices, the one bundle, and the declarations tsc emitted
# into the freshly cleaned dist/ (build:lib removes it first). No source map (not shipped: dist/index.js is the
# readable, unminified bundle), and nothing a stale dist/ could leave behind (an old build.ts wrote host.js and
# devtools.js there, which the old `"files": ["dist"]` packed).
expected="$(
    printf '%s\n' package/package.json package/README.md package/THIRD_PARTY_NOTICES.md package/dist/index.js
    (cd "$root" && find dist -name '*.d.ts' -type f | sed 's|^|package/|')
)"
actual="$(tar -tzf "$tarball")"
if ! diff <(sort <<<"$expected") <(sort <<<"$actual"); then
    echo "package smoke test failed: the tarball's files are not the package's (< expected, > packed)" >&2
    exit 1
fi
if grep -Eq '\.map$|/host\.js$|/devtools\.js$' <<<"$actual"; then
    echo "package smoke test failed: a source map or a stale bundle was packed" >&2
    exit 1
fi

mkdir "$work/consumer"
cd "$work/consumer"
cat > package.json <<'JSON'
{ "name": "consumer", "private": true, "type": "module" }
JSON
bun add "$tarball" >/dev/null
bun add -d typescript >/dev/null

cat > consumer.ts <<'TS'
import { defineWebSandbox, WebSandbox, SAFE_CAPABILITIES, type SandboxConfig } from 'web-sandbox';

const strict: SandboxConfig = { html: '<p>hi</p>', origins: { images: ['https://cdn.example'] } }; // no mode: strict, the default
const config: SandboxConfig = { mode: 'cooperative', capabilities: ['allow-scripts'], unsafeCapabilities: ['fullscreen'] };
// @ts-expect-error 'iframe' was renamed 'cooperative'
const renamed: SandboxConfig = { mode: 'iframe' };
// @ts-expect-error strict mode's origins have no scripts: were the package's types `any`, this line would not be an error
const scripted: SandboxConfig = { mode: 'strict', origins: { scripts: ['https://cdn.example'] } };
const element: typeof WebSandbox = defineWebSandbox('consumer-sandbox');
console.log(element.name, SAFE_CAPABILITIES.length, strict, config, renamed, scripted);
TS
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "ESNext", "module": "Preserve", "moduleResolution": "bundler", "lib": ["ESNext", "DOM"], "strict": true, "noEmit": true, "skipLibCheck": false }, "include": ["consumer.ts"] }
JSON

bunx tsc -p .
# The same consumer under Node's own resolution (review round 1, R4-3): the declarations' relative imports must carry
# their .js extensions (scripts/declaration-specifiers.ts), else TS2834 here; skipLibCheck is off, and the
# @ts-expect-error lines fail the check if the package's types ever read as `any`.
cat > tsconfig.nodenext.json <<'JSON'
{ "compilerOptions": { "target": "ESNext", "module": "NodeNext", "moduleResolution": "NodeNext", "lib": ["ESNext", "DOM"], "strict": true, "noEmit": true, "skipLibCheck": false }, "include": ["consumer.ts"] }
JSON
bunx tsc -p tsconfig.nodenext.json
bun build consumer.ts --target browser --outdir out >/dev/null
echo "package smoke test passed: $(basename "$tarball")"
