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
        rules: { allow: ["jsonplaceholder.typicode.com"], scriptUnsafe: true }
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
        rules: { scriptUnsafe: true }
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
        rules: { scriptUnsafe: true }
    },
    "worker-timeout": {
        id: "worker-timeout",
        label: "Worker Timeout Test",
        code: `console.log("Starting infinite loop...");
while(true) {}`,
        rules: { mode: "worker", executionTimeout: 1000 }
    },
    "vfs-test": {
        id: "vfs-test",
        label: "Virtual Files System Test",
        code: `// This requires a VFS Hub running at /virtual-files
console.log("Checking VFS Base URI...");
console.log(document.baseURI);
fetch('main.js')
  .then(r => r.text())
  .then(t => console.log("Fetched main.js from VFS:", t))
  .catch(e => console.error("VFS Fetch Failed:", e));`,
        rules: { virtualFilesUrl: "http://virtual-files.localhost:4444", scriptUnsafe: true }
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
        rules: { scriptUnsafe: true }
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
        rules: { scriptUnsafe: true }
    },
    "monkey-patch-bypass": {
        id: "monkey-patch-bypass",
        label: "Security Test: Monkey Patch Bypass",
        code: `fetch('http://example.com')
    .then(() => console.log('PWN_SUCCESS'))
    .catch(() => console.log('PWN_FAILURE'));
setTimeout(() => console.log('TEST_DONE'), 1000);`,
        rules: { scriptUnsafe: true }
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
        rules: { scriptUnsafe: true }
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
        rules: { scriptUnsafe: true }
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
        rules: { scriptUnsafe: true }
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
        rules: { scriptUnsafe: true }
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
        rules: { scriptUnsafe: true }
    }
};
