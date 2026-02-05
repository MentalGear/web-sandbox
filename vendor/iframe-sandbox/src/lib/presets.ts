import { NetworkRules } from "./types"

export interface Preset {
    id: string
    label: string
    rules: NetworkRules
    code: string
}

export const PRESETS: Record<string, Preset> = {
    jsonplaceholder: {
        id: "jsonplaceholder",
        label: "JSONPlaceholder (CORS OK)",
        rules: { allow: ["jsonplaceholder.typicode.com"], scriptUnsafe: true },
        code: `// JSONPlaceholder - CORS-friendly API
console.log("Fetching from JSONPlaceholder...");
fetch("https://jsonplaceholder.typicode.com/todos/1")
  .then(r => r.json())
  .then(data => console.log("Got:", data));`,
    },
    //     google: {
    //         id: "google",
    //         label: "Google (CORS Proxy)",
    //         rules: {
    //             allow: ["www.google.com"],
    //             proxyUrl: "/_proxy",
    //             scriptUnsafe: true,
    //         },
    //         code: `// Google - Needs CORS proxy
    // console.log("Fetching Google via proxy...");
    // fetch("https://www.google.com")
    //   .then(r => console.log("Status:", r.status));`,
    //     },
    blocked: {
        id: "blocked",
        label: "Block All",
        rules: { allow: [], scriptUnsafe: true },
        code: `// All external blocked
console.log("Attempting blocked request...");
fetch("https://example.com");`,
    },
    virtualfiles: {
        id: "virtualfiles",
        label: "Virtual Files",
        rules: {
            files: {
                "/config.json": '{"version": "1.0"}',
                "/data.txt": "Hello World",
            },
            scriptUnsafe: true,
        },
        code: `// Virtual files demo
fetch("/config.json").then(r => r.json()).then(d => console.log("Config:", d));
fetch("/data.txt").then(r => r.text()).then(t => console.log("Data:", t));`,
    },
    caching: {
        id: "caching",
        label: "Cache Strategy",
        rules: {
            allow: ["jsonplaceholder.typicode.com"],
            cacheStrategy: "cache-first",
            scriptUnsafe: true,
        },
        code: `// Cache-first strategy demo
console.log("First fetch (network)...");
fetch("https://jsonplaceholder.typicode.com/posts/1");
setTimeout(() => {
  console.log("Second fetch (should hit cache)...");
  fetch("https://jsonplaceholder.typicode.com/posts/1");
}, 1000);`,
    },
    security: {
        id: "security",
        label: "Security Isolation",
        rules: { scriptUnsafe: true },
        code: `// Security isolation tests
console.log("Testing isolation...");

// Test 1: alert() is silently blocked (no modal appears)
alert("If you see this modal, sandbox is broken!");
console.log("PASS: alert() called (check console for sandbox warning)");

// Test 2: window.top should be inaccessible
try {
  const top = window.top.location.href;
  console.error("FAIL: window.top accessible:", top);
} catch (e) {
  console.log("PASS: window.top blocked");
}

// Test 3: document.cookie should be isolated
document.cookie = "sandbox_test=123";
const cookies = document.cookie;
console.log("Sandbox cookies:", cookies);
if (cookies.includes("sandbox_test")) {
  console.log("PASS: Sandbox can set cookies");
}
console.log("Check host devtools - should NOT see 'sandbox_test' cookie");`,
    },
    //     htmlContent: {
    //         id: "htmlContent",
    //         label: "External HTML (MDN)",
    //         rules: {
    //             allow: ["developer.mozilla.org"],
    //             proxyUrl: "/_proxy",
    //             scriptUnsafe: true,
    //         },
    //         code: `// Load external HTML content via proxy
    // const sourceUrl = "https://developer.mozilla.org/";
    // console.log("Fetching MDN homepage...");

    // fetch(sourceUrl)
    //   .then(r => {
    //     console.log("Response status:", r.status);
    //     return r.text();
    //   })
    //   .then(html => {
    //     console.log("HTML loaded, length:", html.length, "chars");
    //     // Inject base tag so relative paths resolve to original domain
    //     const baseTag = '<base href="' + sourceUrl + '">';
    //     const htmlWithBase = html.replace('<head>', '<head>' + baseTag);
    //     // Display the fetched HTML content in the sandbox
    //     document.open();
    //     document.write(htmlWithBase);
    //     document.close();
    //     console.log("HTML content rendered with base tag!");
    //   })
    //   .catch(err => console.error("Fetch failed:", err));`,
    //     },
    localHtml: {
        id: "localHtml",
        label: "Local HTML Page",
        rules: {
            allow: ["localhost", "picsum.photos", "fastly.picsum.photos"],
            scriptUnsafe: true, // Injects scripts via textContent
        },
        code: `// Load local test page from host origin
console.log("Loading local test page...");

const hostOrigin = window.location.origin.replace("sandbox.", "");
const pageUrl = hostOrigin + "/playground/test-assets/test-page.html";

fetch(pageUrl)
  .then(r => r.text())
  .then(html => {
    console.log("HTML loaded, rendering content...");

    // Instead of document.write (which wipes the log relay script),
    // we surgically replace the content while keeping the environment.
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Inject base tag for relative assets
    const base = document.createElement('base');
    base.href = hostOrigin + "/playground/test-assets/";
    document.head.appendChild(base);

    // Replace content
    document.body.innerHTML = doc.body.innerHTML;

    // Copy any scripts from the loaded HTML to execute them
    doc.querySelectorAll('script').forEach(oldScript => {
        const newScript = document.createElement('script');
        Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
        newScript.textContent = oldScript.textContent;
        document.body.appendChild(newScript);
    });

    console.log("Content rendered surgically!");
  })
  .catch(err => console.error("Failed:", err));`,
    },
    originEscape: {
        id: "originEscape",
        label: "Origin Escape Test",
        rules: {
            scriptUnsafe: true, // Injects script tag for testing
        },
        code: `// Security test: Verify origin isolation holds even with outer-frame access
console.log("Testing isolation...");

// Test 1: Try to access outer-frame (should work - same sandbox origin)
try {
    const outerDoc = window.parent.document;
    console.log("Outer-frame access: " + (outerDoc ? "YES (expected)" : "NO"));
} catch (e) {
    console.error("Outer-frame access: BLOCKED (unexpected) - " + e.message);
}

// Test 2: Try to access window.top.document (should fail - cross-origin)
try {
    const topDoc = window.top.document;
    const topTitle = topDoc.title;
    console.error("FAIL: HOST ESCAPE - accessed window.top.document: " + topTitle);
} catch (e) {
    console.log("PASS: window.top.document blocked - " + e.name);
}

// Test 3: Inject script into outer-frame, try to access host from there
try {
    const script = window.parent.document.createElement('script');
    script.textContent = \`
        try {
            const hostDoc = window.top.document;
            console.error("FAIL: HOST ESCAPE from injected script");
        } catch (e) {
            console.log("PASS: Injected script blocked from host - " + e.name);
        }
    \`;
    window.parent.document.body.appendChild(script);
} catch (e) {
    console.error("Script injection failed: " + e.message);
}

console.log("Origin isolation test complete.");`,
    },
    infrastructureTest: {
        id: "infrastructureTest",
        label: "Infrastructure Exposure Test",
        rules: { scriptUnsafe: true },
        code: `// Test: Check that no infrastructure is exposed on window.parent
console.log("Checking for exposed infrastructure...");

const exposedItems = [];

// These should NOT be accessible if IIFE isolation is working
const forbidden = [
    'updateSandboxAttributes',
    'sendStatus',
    'checkState',
    'statusEl',
    'HOST_ORIGIN',
    'innerFrame'
];

for (const name of forbidden) {
    if (typeof window.parent[name] !== 'undefined') {
        exposedItems.push(name);
    }
}

// Also check via window.top[0] path
try {
    if (typeof window.top[0]?.updateSandboxAttributes === 'function') {
        exposedItems.push('window.top[0].updateSandboxAttributes');
    }
} catch (e) {
    // Cross-origin blocked - expected
}

if (exposedItems.length > 0) {
    console.error("FAIL: Exposed items: " + exposedItems.join(", "));
} else {
    console.log("PASS: No infrastructure exposed on window.parent");
}`,
    },
    iframeInjection: {
        id: "iframeInjection",
        label: "Iframe Injection Security Test",
        rules: { scriptUnsafe: true },
        code: `// Test: Try to inject an iframe pointing to an external origin
// Should be blocked by CSP frame-src 'self'
console.log("Attempting to inject external iframe...");

const iframe = document.createElement('iframe');
iframe.src = 'https://example.com';
iframe.id = 'injected-iframe';
document.body.appendChild(iframe);

// Wait and check if we can access content
setTimeout(() => {
    const injected = document.getElementById('injected-iframe');
    try {
        const doc = injected.contentDocument;
        const body = doc?.body?.innerHTML;
        if (body && body.length > 0) {
           console.error("FAIL: Could read iframe content (not blocked)");
        } else {
           console.log("PASS: Iframe content not accessible (blocked or empty)");
        }
    } catch (e) {
        console.log("PASS: Iframe access blocked - " + e.name);
    }
}, 2000);`,
    },
    securityResearch: {
        id: "securityResearch",
        label: "🛡️ Security Research Target",
        rules: {
            allow: [], // Strict networking by default
            scriptUnsafe: true, // Needs to run the harness scripts
        },
        code: `// Load security research harness
console.log("Loading security research target...");

const hostOrigin = window.location.origin.replace("sandbox.", "");
const pageUrl = hostOrigin + "/playground/security-research.html";

fetch(pageUrl)
  .then(r => r.text())
  .then(html => {
    // Replace content surgically
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    document.body.innerHTML = doc.body.innerHTML;

    // Execute harness scripts
    doc.querySelectorAll('script').forEach(oldScript => {
        const newScript = document.createElement('script');
        Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
        newScript.textContent = oldScript.textContent;
        document.body.appendChild(newScript);
    });
  })
  .catch(err => console.error("Failed to load harness:", err));`,
    },
}
