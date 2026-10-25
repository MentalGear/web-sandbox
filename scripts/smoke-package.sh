#!/usr/bin/env bash
# Packs the library with bun, checks that the tarball holds exactly the files the package is (BR:PD9),
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
# readable, unminified bundle), and nothing a stale dist/ could leave behind (a stale host.js or devtools.js, which a
# `"files": ["dist"]` would pack).
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

const sealed: SandboxConfig = { html: '<p>hi</p>' }; // no mode: sealed, the default
const strict: SandboxConfig = { mode: 'strict', html: '<p>hi</p>', origins: { images: ['https://cdn.example'] } };
// @ts-expect-error no mode is sealed mode, which has no network: origins need mode: 'strict'
const unnamed: SandboxConfig = { html: '<p>hi</p>', origins: { images: ['https://cdn.example'] } };
const config: SandboxConfig = { mode: 'cooperative', capabilities: ['allow-scripts'], unsafeCapabilities: ['fullscreen'] };
// @ts-expect-error 'iframe' was renamed 'cooperative'
const renamed: SandboxConfig = { mode: 'iframe' };
// @ts-expect-error strict mode's origins have no scripts: were the package's types `any`, this line would not be an error
const scripted: SandboxConfig = { mode: 'strict', origins: { scripts: ['https://cdn.example'] } };
const element: typeof WebSandbox = defineWebSandbox('consumer-sandbox');
console.log(element.name, SAFE_CAPABILITIES.length, sealed, strict, unnamed, config, renamed, scripted);
TS
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "ESNext", "module": "Preserve", "moduleResolution": "bundler", "lib": ["ESNext", "DOM"], "strict": true, "noEmit": true, "skipLibCheck": false }, "include": ["consumer.ts"] }
JSON

bunx tsc -p .
# The same consumer under Node's own resolution (R1:R4-3): the declarations' relative imports must carry
# their .js extensions (scripts/declaration-specifiers.ts), else TS2834 here; skipLibCheck is off, and the
# @ts-expect-error lines fail the check if the package's types ever read as `any`.
cat > tsconfig.nodenext.json <<'JSON'
{ "compilerOptions": { "target": "ESNext", "module": "NodeNext", "moduleResolution": "NodeNext", "lib": ["ESNext", "DOM"], "strict": true, "noEmit": true, "skipLibCheck": false }, "include": ["consumer.ts"] }
JSON
bunx tsc -p tsconfig.nodenext.json
bun build consumer.ts --target browser --outdir out >/dev/null

# The view bootstrap's hash, the way docs/API.md says to read it for a host page's policy (R2:C-8): importing
# the package in a build step needs no DOM, and gives the same value from a consumer's minified bundle, because the
# bootstrap is a string literal of the package. The browser's side (the hash in the view's policy) is
# test/e2e/package.spec.ts.
cat > hash.ts <<'TS'
export { viewScriptHash } from 'web-sandbox';
TS
bun build hash.ts --target browser --minify --outdir out-min >/dev/null
plain="$(bun -e "import { viewScriptHash } from 'web-sandbox'; console.log(viewScriptHash())")"
minified="$(bun -e "import { viewScriptHash } from './out-min/hash.js'; console.log(viewScriptHash())")"
if ! grep -Eq "^'sha256-[A-Za-z0-9+/]{43}='$" <<<"$plain" || [ "$plain" != "$minified" ]; then
    echo "package smoke test failed: viewScriptHash() is \"$plain\" from the package and \"$minified\" from a minified bundle of it" >&2
    exit 1
fi
if command -v node >/dev/null; then
    in_node="$(node --input-type=module -e "import { viewScriptHash } from 'web-sandbox'; console.log(viewScriptHash())")"
    if [ "$in_node" != "$plain" ]; then
        echo "package smoke test failed: viewScriptHash() in Node is \"$in_node\", in Bun \"$plain\"" >&2
        exit 1
    fi
fi
echo "package smoke test passed: $(basename "$tarball"), view bootstrap $plain"
