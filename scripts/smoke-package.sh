#!/usr/bin/env bash
# Packs the library with bun, checks that the tarball holds exactly the files the package is (BR:PD9),
# installs it into a throwaway consumer project, and checks that the public entry point resolves, type-checks and
# bundles (backlog D1). Once for each build (ADR-009): the build with the network modes first, then the default build,
# which is the package as published and what dist/ holds when this script ends.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The consumer of each build: what type-checks against its declarations, and what must not.
consumer_default() {
    cat <<'TS'
import { defineWebSandbox, WebSandbox, SAFE_CAPABILITIES, type SandboxConfig, type SealedSandboxConfig } from 'web-sandbox';

const sealed: SandboxConfig = { html: '<p>hi</p>' }; // no mode: sealed, the default
const named: SealedSandboxConfig = { mode: 'sealed', entry: 'main.js', capabilities: ['allow-orientation-lock'] };
// @ts-expect-error the default build has sealed mode alone: strict mode is a network mode (WEB_SANDBOX_NETWORK_MODES=1)
const strict: SandboxConfig = { mode: 'strict', html: '<p>hi</p>' };
// @ts-expect-error nor cooperative mode
const cooperative: SandboxConfig = { mode: 'cooperative', capabilities: ['allow-scripts'] };
// @ts-expect-error nor worker mode
const worker: SandboxConfig = { mode: 'worker' };
// @ts-expect-error sealed mode has no network: no origins
const unnamed: SandboxConfig = { html: '<p>hi</p>', origins: { images: ['https://cdn.example'] } };
// @ts-expect-error and no fetch bridge
const bridged: SandboxConfig = { fetchBridge: { allow: [] } };
// @ts-expect-error 'iframe' is no mode: were the package's types `any`, this line would not be an error
const renamed: SandboxConfig = { mode: 'iframe' };
const element: typeof WebSandbox = defineWebSandbox('consumer-sandbox');
console.log(element.name, SAFE_CAPABILITIES.length, sealed, named, strict, cooperative, worker, unnamed, bridged, renamed);
TS
}

consumer_network() {
    cat <<'TS'
import { defineWebSandbox, WebSandbox, SAFE_CAPABILITIES, UNSAFE_CAPABILITIES, type SandboxConfig, type StrictSandboxConfig, type WebSandboxEventMap } from 'web-sandbox';

const sealed: SandboxConfig = { html: '<p>hi</p>' }; // no mode: sealed, the default
const strict: SandboxConfig = { mode: 'strict', html: '<p>hi</p>', origins: { images: ['https://cdn.example'] } };
const typed: StrictSandboxConfig = { mode: 'strict', fetchBridge: { allow: ['https://api.example'] } };
// @ts-expect-error no mode is sealed mode, which has no network: origins need mode: 'strict'
const unnamed: SandboxConfig = { html: '<p>hi</p>', origins: { images: ['https://cdn.example'] } };
const config: SandboxConfig = { mode: 'cooperative', capabilities: ['allow-scripts'], unsafeCapabilities: ['fullscreen'] };
// @ts-expect-error 'iframe' was renamed 'cooperative'
const renamed: SandboxConfig = { mode: 'iframe' };
// @ts-expect-error strict mode's origins have no scripts: were the package's types `any`, this line would not be an error
const scripted: SandboxConfig = { mode: 'strict', origins: { scripts: ['https://cdn.example'] } };
// the network modes' event is in the element's event map, by declaration merging
const fetched: WebSandboxEventMap['fetch'] | null = null;
const element: typeof WebSandbox = defineWebSandbox('consumer-sandbox');
console.log(element.name, SAFE_CAPABILITIES.length, UNSAFE_CAPABILITIES.length, sealed, strict, typed, unnamed, config, renamed, scripted, fetched);
TS
}

# smoke <build> <flag value>: builds, packs and consumes that build of the package.
smoke() {
    local build="$1" flag="$2" consumer="$work/consumer-$1"
    cd "$root"
    WEB_SANDBOX_NETWORK_MODES="$flag" bun run build:lib >/dev/null
    mkdir "$work/pack-$build"
    bun pm pack --destination "$work/pack-$build" --quiet >/dev/null
    local tarball
    tarball="$(ls "$work/pack-$build"/*.tgz)"

    # The manifest, exactly: package.json, the README and the notices, the one bundle, and the declarations tsc emitted
    # into the freshly cleaned dist/ (build:lib removes it first). No source map (not shipped: dist/index.js is the
    # readable, unminified bundle), and nothing a stale dist/ could leave behind (a stale host.js or devtools.js, which a
    # `"files": ["dist"]` would pack).
    local expected actual
    expected="$(
        printf '%s\n' package/package.json package/README.md package/LICENSE package/THIRD_PARTY_NOTICES.md package/dist/index.js
        (cd "$root" && find dist -name '*.d.ts' -type f | sed 's|^|package/|')
    )"
    actual="$(tar -tzf "$tarball")"
    if ! diff <(sort <<<"$expected") <(sort <<<"$actual"); then
        echo "package smoke test failed ($build build): the tarball's files are not the package's (< expected, > packed)" >&2
        exit 1
    fi
    if grep -Eq '\.map$|/host\.js$|/devtools\.js$' <<<"$actual"; then
        echo "package smoke test failed ($build build): a source map or a stale bundle was packed" >&2
        exit 1
    fi
    # The default build is sealed mode alone (ADR-009): its bundle declares nothing of the network modes' own modules,
    # and its declarations hold none of their types' modules.
    if [ "$build" = default ]; then
        if grep -Eq 'function (inBridgeFrame|workerBootstrap|createFetchBridge|parseOrigins|hostReach|rewriteGuestMarkup|inSandboxMarkup|inSandboxImportMap)\(' dist/index.js; then
            echo "package smoke test failed: the default build's bundle holds code of the network modes" >&2
            exit 1
        fi
        if grep -Eq '/(network|lib/network-(config|host|install|types)|lib/csp/origins|lib/csp/host-connect|lib/bridge-frame|lib/host-site|lib/cookie-facts)\.d\.ts$' <<<"$actual"; then
            echo "package smoke test failed: the default build's declarations hold a module of the network modes" >&2
            exit 1
        fi
    fi

    mkdir "$consumer"
    cd "$consumer"
    cat > package.json <<'JSON'
{ "name": "consumer", "private": true, "type": "module" }
JSON
    bun add "$tarball" >/dev/null
    bun add -d typescript >/dev/null

    "consumer_$build" > consumer.ts
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
    local plain minified in_node
    plain="$(bun -e "import { viewScriptHash } from 'web-sandbox'; console.log(viewScriptHash())")"
    minified="$(bun -e "import { viewScriptHash } from './out-min/hash.js'; console.log(viewScriptHash())")"
    if ! grep -Eq "^'sha256-[A-Za-z0-9+/]{43}='$" <<<"$plain" || [ "$plain" != "$minified" ]; then
        echo "package smoke test failed ($build build): viewScriptHash() is \"$plain\" from the package and \"$minified\" from a minified bundle of it" >&2
        exit 1
    fi
    if command -v node >/dev/null; then
        in_node="$(node --input-type=module -e "import { viewScriptHash } from 'web-sandbox'; console.log(viewScriptHash())")"
        if [ "$in_node" != "$plain" ]; then
            echo "package smoke test failed ($build build): viewScriptHash() in Node is \"$in_node\", in Bun \"$plain\"" >&2
            exit 1
        fi
    fi
    echo "package smoke test passed: $(basename "$tarball"), the $build build, view bootstrap $plain"
}

smoke network 1
smoke default ''
