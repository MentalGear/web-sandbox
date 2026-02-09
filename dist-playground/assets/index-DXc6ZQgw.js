(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))n(r);new MutationObserver(r=>{for(const s of r)if(s.type==="childList")for(const a of s.addedNodes)a.tagName==="LINK"&&a.rel==="modulepreload"&&n(a)}).observe(document,{childList:!0,subtree:!0});function o(r){const s={};return r.integrity&&(s.integrity=r.integrity),r.referrerPolicy&&(s.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?s.credentials="include":r.crossOrigin==="anonymous"?s.credentials="omit":s.credentials="same-origin",s}function n(r){if(r.ep)return;r.ep=!0;const s=o(r);fetch(r.href,s)}})();window.playground={saveState(){if(document.getElementById("presetSelect").value!=="custom"){localStorage.removeItem("safeSandbox_customState");return}const e={code:document.getElementById("code").value,rules:document.getElementById("rulesEditor").value,timestamp:Date.now()};localStorage.setItem("safeSandbox_customState",JSON.stringify(e))},loadState(){const t=localStorage.getItem("safeSandbox_customState");if(t)try{const e=JSON.parse(t);return document.getElementById("code").value=e.code,document.getElementById("rulesEditor").value=e.rules,document.getElementById("presetSelect").value="custom",!0}catch(e){console.warn("Failed to load playground state:",e)}return!1},triggerCustomMode(){const t=document.getElementById("presetSelect");t.value!=="custom"&&(t.value="custom",this.saveState())},tagLog(t,e){t.setAttribute("data-category",e),t.classList.add(`cat-${e}`),this.currentFilter!=="all"&&this.currentFilter!==e&&(t.style.display="none")}};class S extends HTMLElement{_iframe=null;_worker=null;_config={mode:"iframe"};_sessionId;_port=null;_hubFrame=null;_timeoutId=null;constructor(){super(),this.attachShadow({mode:"open"}),this._sessionId=crypto.randomUUID()}connectedCallback(){this.initialize()}setConfig(e){this._config={...this._config,...e},this._config.virtualFilesUrl&&!this._hubFrame&&(this._hubFrame=document.createElement("iframe"),this._hubFrame.style.display="none",this._hubFrame.src=`${this._config.virtualFilesUrl}/hub.html`,document.body.appendChild(this._hubFrame)),this.initialize()}registerFiles(e){if(this._hubFrame&&this._hubFrame.contentWindow){let o=this._config.virtualFilesUrl||"*";o.startsWith("/")&&(o=new URL(o,window.location.origin).origin),this._hubFrame.contentWindow.postMessage({type:"PUT_FILES",sessionId:this._sessionId,files:e},o)}else console.warn("Virtual Files Hub not ready or configured")}execute(e){this._port?(this._startTimeout(),this._port.postMessage({type:"EXECUTE",code:e})):console.warn("Sandbox not ready (no port)")}_startTimeout(){this._timeoutId&&clearTimeout(this._timeoutId),this._config.mode==="worker"&&this._config.executionTimeout&&this._config.executionTimeout>0&&(this._timeoutId=setTimeout(()=>{console.warn("[Sandbox] Execution Timeout - Terminating Worker"),window.dispatchEvent(new CustomEvent("sandbox-log",{detail:{type:"LOG",level:"error",args:["Execution Timeout"]}})),this._worker&&(this._worker.terminate(),this._worker=null,this._port&&(this._port.close(),this._port=null),this.spawnWorker())},this._config.executionTimeout))}setupChannel(e){const o=new MessageChannel;this._port=o.port1,this._port.onmessage=n=>{n.data.type==="LOG"&&window.dispatchEvent(new CustomEvent("sandbox-log",{detail:n.data}))},e instanceof Worker?e.postMessage({type:"INIT_PORT"},[o.port2]):e.postMessage({type:"INIT_PORT"},"*",[o.port2])}initialize(){this._iframe&&(this._iframe.remove(),this._iframe=null),this._worker&&(this._worker.terminate(),this._worker=null),this._port&&(this._port.close(),this._port=null),this._timeoutId&&clearTimeout(this._timeoutId),this._config.mode==="worker"?this.spawnWorker():this.createIframe()}spawnWorker(){const e=`
            self.onmessage = (e) => {
                if (e.data.type === 'INIT_PORT') {
                    const port = e.ports[0];
                    port.onmessage = (ev) => {
                        if (ev.data.type === 'EXECUTE') {
                            try {
                                const func = new Function(ev.data.code);
                                func();
                            } catch (err) {
                                port.postMessage({ type: 'LOG', level: 'error', args: [err.message] });
                            }
                        }
                    };
                    ['log', 'error', 'warn'].forEach(level => {
                        const original = console[level];
                        console[level] = (...args) => {
                            port.postMessage({ type: 'LOG', level, args });
                        };
                    });
                    port.postMessage({ type: 'LOG', level: 'info', args: ['Worker Ready'] });
                }
            };
        `,o=new Blob([e],{type:"application/javascript"});this._worker=new Worker(URL.createObjectURL(o)),this.setupChannel(this._worker),setTimeout(()=>this.dispatchEvent(new CustomEvent("ready")),0)}createIframe(){this._iframe=document.createElement("iframe"),this._iframe.setAttribute("sandbox","allow-scripts allow-forms allow-popups allow-modals"),this._iframe.style.cssText="width:100%;height:100%;border:none",this.shadowRoot.appendChild(this._iframe);const e=this._config.virtualFilesUrl?`${this._config.virtualFilesUrl}/${this._sessionId}/`:"",o=this._config.allow||[];let n=o.length>0?o.join(" "):"";!n&&!e&&(n="'none'");const a=`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${["default-src 'none'",`script-src ${this._config.scriptUnsafe?"'self' 'unsafe-inline' 'unsafe-eval'":"'self' 'unsafe-inline'"} ${e||""}`,`connect-src ${n} ${e||""}`,"style-src 'unsafe-inline'",`base-uri 'none' ${e||""}`,"frame-src 'none'","object-src 'none'","form-action 'none'"].join("; ")}">
    ${e?`<base href="${e}">`:""}
    <script>
        // Defense-in-depth: Block nested iframes
        const originalCreateElement = document.createElement;
        document.createElement = function(tagName, options) {
            if (tagName.toLowerCase() === 'iframe') {
                throw new Error("Nested iframes are blocked.");
            }
            return originalCreateElement.call(document, tagName, options);
        };

        // Defense-in-depth: Hide Service Workers
        try {
            Object.defineProperty(window.Navigator.prototype, 'serviceWorker', {
                get: function() { return undefined; },
                configurable: true
            });
        } catch (e) {}

        window.addEventListener('message', (event) => {
            if (event.data?.type === 'INIT_PORT') {
                const port = event.ports[0];
                port.onmessage = (ev) => {
                    if (ev.data.type === 'EXECUTE') {
                        try {
                            // Ensure the code execution itself doesn't crash the port logic
                            const func = new Function(ev.data.code);
                            func();
                        } catch (e) {
                            port.postMessage({ type: 'LOG', level: 'error', args: [e.message] });
                        }
                    }
                };

                ['log', 'error', 'warn'].forEach(level => {
                    const original = console[level];
                    console[level] = (...args) => {
                        port.postMessage({ type: 'LOG', level, args });
                        original.apply(console, args);
                    };
                });
                port.postMessage({ type: 'LOG', level: 'info', args: ['Iframe Ready'] });
            }
        }, { once: true });
    <\/script>
</head>
<body><div id="root"></div></body>
</html>
        `;this._iframe.onload=()=>{this._iframe?.contentWindow&&(this.setupChannel(this._iframe.contentWindow),this.dispatchEvent(new CustomEvent("ready")))},this._iframe.srcdoc=a}}customElements.define("lofi-sandbox",S);console.log("Module 1: System check");window.moduleSystemWorking=!0;const p={basic:{id:"basic",label:"Basic Interaction",code:`console.log("Hello from the Sandbox!");
fetch("https://jsonplaceholder.typicode.com/todos/1")
  .then(r => r.json())
  .then(j => console.log("Fetched:", j));`,rules:{allow:["https://jsonplaceholder.typicode.com"],scriptUnsafe:!0}},"csp-bypass":{id:"csp-bypass",label:"Security Test: CSP Bypass",code:`(async () => {
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
    })();`,rules:{scriptUnsafe:!0}},"sw-tamper":{id:"sw-tamper",label:"Security Test: SW Tampering",code:`if (!navigator.serviceWorker) {
     console.log('PWN_FAILURE');
} else {
     console.log('PWN_SUCCESS');
}
setTimeout(() => console.log('TEST_DONE'), 100);`,rules:{scriptUnsafe:!0}},"worker-timeout":{id:"worker-timeout",label:"Worker Timeout Test",code:`console.log("Starting infinite loop...");
while(true) {}`,rules:{mode:"worker",executionTimeout:1e3}},"vfs-test":{id:"vfs-test",label:"Virtual Files System Test",code:`// This requires a VFS Hub running at /virtual-files
console.log("Checking VFS Base URI...");
console.log(document.baseURI);
fetch('main.js')
  .then(r => r.text())
  .then(t => console.log("Fetched main.js from VFS:", t))
  .catch(e => console.error("VFS Fetch Failed:", e));`,rules:{virtualFilesUrl:"http://virtual-files.localhost:4444",scriptUnsafe:!0}},"websocket-bypass":{id:"websocket-bypass",label:"Security Test: WebSocket Bypass",code:`try {
    const ws = new WebSocket('wss://echo.websocket.events');
    ws.onopen = () => console.log('PWN_SUCCESS');
    ws.onerror = () => console.log('PWN_FAILURE');
} catch(e) {
    console.log('PWN_FAILURE');
}
setTimeout(() => console.log('TEST_DONE'), 1000);`,rules:{scriptUnsafe:!0}},"outer-frame-tampering":{id:"outer-frame-tampering",label:"Security Test: Outer Frame Tampering",code:`try {
    const p = window.parent.document;
    console.log('PWN_SUCCESS');
} catch(e) {
    console.log('PWN_FAILURE');
}
setTimeout(() => console.log('TEST_DONE'), 100);`,rules:{scriptUnsafe:!0}},"monkey-patch-bypass":{id:"monkey-patch-bypass",label:"Security Test: Monkey Patch Bypass",code:`fetch('http://example.com')
    .then(() => console.log('PWN_SUCCESS'))
    .catch(() => console.log('PWN_FAILURE'));
setTimeout(() => console.log('TEST_DONE'), 1000);`,rules:{scriptUnsafe:!0}},"protocol-handler":{id:"protocol-handler",label:"Security Test: Protocol Handler",code:`try {
    navigator.registerProtocolHandler('web+test', 'https://example.com?q=%s', 'Test Handler');
    console.log('PWN_SUCCESS: Handler Registered');
} catch (e) {
    console.log('PWN_FAILURE: ' + e.message);
}
console.log('TEST_DONE');`,rules:{scriptUnsafe:!0}},"data-uri":{id:"data-uri",label:"Security Test: Data URI Navigation",code:`try {
    const dataUrl = 'data:text/html,<h1>PWNED</h1>';
    window.top.location.href = dataUrl;
} catch (e) {
    console.log('PWN_FAILURE: ' + e.message);
}
console.log('TEST_DONE');`,rules:{scriptUnsafe:!0}},"session-exhaustion":{id:"session-exhaustion",label:"Security Test: Session Exhaustion",code:`(async () => {
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
})();`,rules:{scriptUnsafe:!0}},"base-tag":{id:"base-tag",label:"Security Test: Base Tag Hijacking",code:`try {
    const base = document.createElement('base');
    base.href = 'https://google.com';
    document.head.appendChild(base);

    fetch('foo', { mode: 'no-cors' })
        .then(() => console.log('PWN_SUCCESS'))
        .catch(e => console.log('PWN_FAILURE: ' + e.message));

} catch (e) {
    console.log('PWN_FAILURE: ' + e.message);
}
setTimeout(() => console.log('TEST_DONE'), 2000);`,rules:{scriptUnsafe:!0}},"storage-sharing":{id:"storage-sharing",label:"Security Test: Storage Sharing",code:`// Write
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
console.log('TEST_DONE');`,rules:{scriptUnsafe:!0}}};console.log("Module 2: Imported PRESETS",p);const d=[],l=document.getElementById("sandbox"),u=document.getElementById("logs");let m=!0;console.log("Elements found:",l,u);const g=document.getElementById("presetSelect");g||console.error("Select not found");const f=g.querySelector('option[value="custom"]');f||console.error("Custom option not found");console.log("Populating presets...");Object.values(p).forEach(t=>{const e=document.createElement("option");e.value=t.id,e.textContent=t.label,g.insertBefore(e,f)});console.log("Presets populated");window.appendLocalLog=t=>{y({source:"playground",message:t,level:"log"})};console.log("Defined appendLocalLog");window.addEventListener("sandbox-log",t=>{const e=t.detail;e.level==="info"&&(e.level="log");const o=e.message||(e.args?e.args.join(" "):"");if(o==="Iframe Ready"||o==="Worker Ready"){document.getElementById("sandbox-status").textContent="Sandbox: Ready",document.getElementById("sandbox-status").style.color="#4caf50",appendLocalLog("Sandbox is ready!");return}const n={source:"inner",level:e.level,message:o};d.push(n),y(n)});window.addEventListener("load",()=>{playground.loadState()?window.applyNetworkRules():window.loadPreset()});console.log("Added load listener");function y(t){m&&(u.innerHTML="",m=!1);const e=document.createElement("div");e.className="log-entry";const o=t.source||t.depth||"host",n=t.level||t.logType||"log",r=t.message||(t.args?t.args.join(" "):""),s=t.area||"",a=n==="error",w=a?"#ff5252":n==="warn"?"#ffb74d":"#4caf50",i=document.createElement("span");i.style.color=w,i.textContent=`[${o}${s?":"+s:""}] `;const c=document.createElement("span");if(c.style.color=a?"#ff5252":"inherit",c.textContent=r,e.appendChild(i),e.appendChild(c),s&&e.classList.add(`cat-${s}`),u.prepend(e),window.playground&&window.playground.tagLog){const E=s==="network"?"network":s==="security"?"security":o==="inner"?"user-code":"host";window.playground.tagLog(e,E)}}window.loadPreset=()=>{const t=document.getElementById("presetSelect").value;if(t==="none")return;if(t==="custom"){playground.loadState();return}const e=p[t];e&&(document.getElementById("rulesEditor").value=JSON.stringify(e.rules,null,2),document.getElementById("code").value=e.code,window.applyNetworkRules(),playground.saveState())};window.onCodeInput=()=>{playground.triggerCustomMode(),playground.saveState()};window.onRulesInput=()=>{playground.triggerCustomMode(),playground.saveState(),window.debounceApplyRules()};let h;window.debounceApplyRules=()=>{clearTimeout(h),h=setTimeout(()=>{window.applyNetworkRules()},500)};window.applyNetworkRules=()=>{const t=document.getElementById("rulesEditor").value;try{const e=JSON.parse(t);l.setConfig(e),window.appendLocalLog("Config applied.");const o=document.getElementById("proxyToggle");if(o){const n=!!e.proxyUrl;o.style.background=n?"var(--primary)":"#444",o.textContent=`Proxy: ${n?"ON":"OFF"}`}}catch{}};window.runCode=()=>{const t=document.getElementById("code").value;window.appendLocalLog("Applying network rules ..."),window.applyNetworkRules(),window.appendLocalLog("Executing code..."),l.execute(t)};window.clearLogs=()=>{document.getElementById("logs").innerHTML=""};window.resetSandbox=async()=>{window.appendLocalLog("Resetting sandbox..."),localStorage.removeItem("safeSandbox_customState"),l.setConfig({})};window.addEventListener("message",t=>{t.data?.type==="RESET_COMPLETE"&&window.location.reload(!0)});window.SandboxControl={sandboxElement:l,execute:t=>{l.execute(t)},setConfig:t=>{l.setConfig(t),setTimeout(()=>l.dispatchEvent(new CustomEvent("ready")),100)},getLogs:()=>d,clearLogs:()=>{d.length=0,document.getElementById("logs").innerHTML=""}};console.log("SandboxControl exposed");
