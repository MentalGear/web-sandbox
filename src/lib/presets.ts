/**
 * Playground Presets
 * Pre-defined scenarios to demonstrate sandbox capabilities and testing.
 */

export const PRESETS = {
    "basic": {
        id: "basic",
        label: "Basic Interaction",
        code: `console.log("Hello from the Sandbox!");
fetch("https://jsonplaceholder.typicode.com/todos/1")
  .then(r => r.json())
  .then(j => console.log("Fetched:", j));`,
        rules: { allow: ["https://jsonplaceholder.typicode.com"], scriptUnsafe: true, capabilities: ["allow-scripts"], },
    },
    "csp-bypass": {
        id: "csp-bypass",
        label: "Security Test: CSP Bypass",
        code: `(async () => {
      try {
          const iframe = document.createElement('iframe');
          iframe.src = "javascript:alert(1)";
          document.body.appendChild(iframe);

          iframe.onload = () => console.log('PWN_SUCCESS');
          iframe.onerror = () => console.log('PWN_FAILURE');

          // Wait a bit for async load
          setTimeout(() => {
              console.log('TEST_DONE');
          }, 500);
      } catch (e) {
          console.log('TEST_DONE');
      }
    })();`,
        rules: { scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "sw-tamper": {
        id: "sw-tamper",
        label: "Security Test: SW Tampering",
        code: `if (!navigator.serviceWorker) {
     console.log('PWN_FAILURE');
} else {
     console.log('PWN_SUCCESS');
}
setTimeout(() => console.log('TEST_DONE'), 100);`,
        rules: { scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "worker-timeout": {
        id: "worker-timeout",
        label: "Worker Timeout Test",
        code: `console.log("Starting infinite loop...");
while(true) {}`,
        rules: { mode: "worker", executionTimeout: 1000 }
    },
    "virtual-files-test": {
        id: "virtual-files-test",
        label: "Virtual Files System Test",
        code: `// This requires a VFS Hub running at /virtual-files
console.log("Checking VFS Base URI...");
console.log(document.baseURI);
fetch('main.js')
  .then(r => r.text())
  .then(t => console.log("Fetched main.js from VFS:", t))
  .catch(e => console.error("VFS Fetch Failed:", e));`,
        rules: { virtualFilesUrl: "http://virtual-files.localhost:4444", scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "websocket-bypass": {
        id: "websocket-bypass",
        label: "Security Test: WebSocket Bypass",
        code: `try {
    const ws = new WebSocket('wss://echo.websocket.events');
    ws.onopen = () => console.log('PWN_SUCCESS');
    ws.onerror = () => console.log('PWN_FAILURE');
} catch(e) {
    console.log('PWN_FAILURE');
}
setTimeout(() => console.log('TEST_DONE'), 1000);`,
        rules: { scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "outer-frame-tampering": {
        id: "outer-frame-tampering",
        label: "Security Test: Outer Frame Tampering",
        code: `try {
    const p = window.parent.document;
    console.log('PWN_SUCCESS');
} catch(e) {
    console.log('PWN_FAILURE');
}
setTimeout(() => console.log('TEST_DONE'), 100);`,
        rules: { scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "monkey-patch-bypass": {
        id: "monkey-patch-bypass",
        label: "Security Test: Monkey Patch Bypass",
        code: `fetch('http://example.com')
    .then(() => console.log('PWN_SUCCESS'))
    .catch(() => console.log('PWN_FAILURE'));
setTimeout(() => console.log('TEST_DONE'), 1000);`,
        rules: { scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "protocol-handler": {
        id: "protocol-handler",
        label: "Security Test: Protocol Handler",
        code: `try {
    navigator.registerProtocolHandler('web+test', 'https://example.com?q=%s', 'Test Handler');
    console.log('PWN_SUCCESS: Handler Registered');
} catch (e) {
    console.log('PWN_FAILURE: ' + e.message);
}
console.log('TEST_DONE');`,
        rules: { scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "data-uri": {
        id: "data-uri",
        label: "Security Test: Data URI Navigation",
        code: `try {
    const dataUrl = 'data:text/html,<h1>PWNED</h1>';
    window.top.location.href = dataUrl;
} catch (e) {
    console.log('PWN_FAILURE: ' + e.message);
}
console.log('TEST_DONE');`,
        rules: { scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "session-exhaustion": {
        id: "session-exhaustion",
        label: "Security Test: Session Exhaustion",
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
        rules: { scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "base-tag": {
        id: "base-tag",
        label: "Security Test: Base Tag Hijacking",
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
        rules: { scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "storage-sharing": {
        id: "storage-sharing",
        label: "Security Test: Storage Sharing",
        code: `// Write
try {
    localStorage.setItem('SECRET', '123');
    console.log('Write Done');
} catch(e) {
    console.log('Write Failed');
}

// Read (Simulated in same execution for preset simplicity, but in test it's separate)
try {
    const val = localStorage.getItem('SECRET');
    console.log('Read: ' + val);
} catch(e) {
    console.log('Read Failed');
}
    console.log('TEST_DONE');`,
        rules: { scriptUnsafe: true, capabilities: ["allow-scripts"] }
    },
    "alert-test": {
        id: "alert-test",
        label: "Security Test: Block Alert/Dialog",
        code: `try {
    alert("If you see this, alert() is not blocked");
    console.log('PWN_SUCCESS');
} catch (e) {
    console.log('PWN_FAILURE: ' + e.message);
}
console.log('TEST_DONE');`,
        rules: { scriptUnsafe: true, capabilities: ["allow-scripts",] }
    },
    "allow-same-origin": {
        id: "allow-same-origin",
        label: "Security Test: allow-same-origin Filter",
        code: `if (window.origin !== 'null') {
    console.log('PWN_SUCCESS: allow-same-origin was NOT filtered!');
} else {
    console.log('PASS: Origin is opaque. Filter working.');
}
console.log('TEST_DONE');`,
        rules: { capabilities: ["allow-scripts", "allow-same-origin" as any], scriptUnsafe: true }
    },
    "allow-top-nav": {
        id: "allow-top-nav",
        label: "Security Test: allow-top-navigation Filter",
        code: `try {
    window.top.location.href = 'about:blank';
    console.log('PWN_SUCCESS: Top navigation allowed!');
} catch (e) {
    console.log('PASS: Top navigation blocked (' + e.message + ')');
}
console.log('TEST_DONE');`,
        rules: { capabilities: ["allow-scripts", "allow-top-navigation" as any], scriptUnsafe: true }
    },
    "allow-popups-escape": {
        id: "allow-popups-escape",
        label: "Security Test: allow-popups-to-escape-sandbox Filter",
        code: `(async () => {
    console.log("Note: 'allow-popups' is permitted, but 'allow-popups-to-escape-sandbox' is filtered.");
    console.log("This test requires you to allow popups for this site in your browser settings.");
    const win = window.open('about:blank', '_blank');
    if (win) {
        console.log("PWN_INFO: Popup opened (as expected via allow-popups).");
        console.log("If the filter worked, this new window is STILL sandboxed and cannot escape to the host origin.");
    } else {
        console.log("PWN_FAILURE: Popup was blocked by the browser's popup blocker. Please allow popups and run again.");
    }
    console.log('TEST_DONE');
})();`,
        rules: { capabilities: ["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox" as any], scriptUnsafe: true }
    }
};
