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
const element: typeof WebSandbox = defineWebSandbox({ tagName: 'consumer-sandbox', documentUrl: '/sealed-document.html' });
// @ts-expect-error the default build's sealed mode has no view without the served file: documentUrl is required
defineWebSandbox({ tagName: 'consumer-sandbox' });
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
const element: typeof WebSandbox = defineWebSandbox({ tagName: 'consumer-sandbox', documentUrl: new URL('/sealed-document.html', location.href) });
// the network modes keep documents of their own: a registration without documentUrl runs them, and refuses sealed mode
const networkOnly: typeof WebSandbox = defineWebSandbox({ tagName: 'network-only-sandbox' });
console.log(element.name, networkOnly.name, SAFE_CAPABILITIES.length, UNSAFE_CAPABILITIES.length, sealed, strict, typed, unnamed, config, renamed, scripted, fetched);
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

    # The manifest, exactly: package.json, the README and the notices, the one bundle, sealed mode's served document, and
    # the declarations tsc emitted into the freshly cleaned dist/ (build:lib removes it first). No source map (not
    # shipped: dist/index.js is the readable, unminified bundle), and nothing a stale dist/ could leave behind (a stale
    # host.js or devtools.js, which a `"files": ["dist"]` would pack).
    local expected actual
    expected="$(
        printf '%s\n' package/package.json package/README.md package/LICENSE package/THIRD_PARTY_NOTICES.md package/dist/index.js package/dist/sealed-document.html
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

    # Sealed mode's served document (design 03): exported as ./sealed-document.html, and the installed file is the one the
    # build wrote. Both builds write the same bytes (I12): the first build's file is kept, and the second's must equal it.
    local served
    served="$(bun -e "console.log(Bun.resolveSync('web-sandbox/sealed-document.html', process.cwd()))")"
    if ! cmp -s "$served" "$root/dist/sealed-document.html"; then
        echo "package smoke test failed ($build build): web-sandbox/sealed-document.html resolves to $served, which is not the file the build wrote" >&2
        exit 1
    fi
    if [ -f "$work/sealed-document.html" ]; then
        if ! cmp -s "$work/sealed-document.html" "$served"; then
            echo "package smoke test failed: the $build build's sealed-document.html differs from the other build's (I12)" >&2
            exit 1
        fi
    else
        cp "$served" "$work/sealed-document.html"
    fi
    # The check of the file (design 03) compares a served file with the digest the bundle carries: the digest the file
    # states of itself, its version, which is the SHA-256 of the file without it (src/lib/document-digest.ts); the
    # installed bundle holds it, in base64, and so does a consumer's bundle of it.
    local digest
    digest="$(bun -e "import { statedDigest } from '$root/src/lib/document-digest.ts'; const stated = statedDigest(await Bun.file(process.argv[1]).text()); if (stated === null) process.exit(1); process.stdout.write(stated);" "$served")" || {
        echo "package smoke test failed ($build build): sealed-document.html does not state a digest that holds" >&2
        exit 1
    }
    for bundle in "$(dirname "$served")/index.js" out/consumer.js; do
        if ! grep -qF "\"$digest\"" "$bundle"; then
            echo "package smoke test failed ($build build): $bundle does not hold the digest of sealed-document.html ($digest)" >&2
            exit 1
        fi
    done
    echo "package smoke test passed: $(basename "$tarball"), the $build build, view bootstrap $plain, sealed-document.html $(sha256sum "$served" | cut -c1-16)"
}

smoke network 1
smoke default ''
