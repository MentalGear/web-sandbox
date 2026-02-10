import "./state.ts"

import { LofiSandbox } from '@src/host.ts';
customElements.define("lofi-sandbox", LofiSandbox);

import { SandboxDevTools } from '@src/devtools.ts';
import { PRESETS } from '@src/lib/presets.ts';
// console.log("Imported PRESETS", PRESETS);

const capturedLogs = [];
const sandbox = document.getElementById('sandbox');
const vfSandbox = document.getElementById('virtual-files-sandbox');
const logsDiv = document.getElementById('logs');
let firstLog = true;

console.log("Elements found:", sandbox, logsDiv);

// Initialize DevTools
// We attach devtools to the virtual-files sandbox as it's more relevant there
const devtools = new SandboxDevTools(vfSandbox as LofiSandbox);
const toggleBtn = document.getElementById('toggleDevTools');
if (toggleBtn) {
    toggleBtn.onclick = () => devtools.toggle();
}

// Listen for readiness on the sandbox elements directly
sandbox.addEventListener('ready', () => {
    document.getElementById('sandbox-status').textContent = 'Sandbox: Ready';
    document.getElementById('sandbox-status').style.color = '#4caf50';
    window.appendLocalLog('Direct sandbox is ready!');
    
    const runBtn = document.getElementById('runButton') as HTMLButtonElement;
    if (runBtn) runBtn.disabled = false;

    const runHtmlBtn = document.getElementById('runHtmlButton') as HTMLButtonElement;
    if (runHtmlBtn) runHtmlBtn.disabled = false;
});

vfSandbox.addEventListener('ready', () => {
    const vfStatus = document.getElementById('virtual-files-status');
    if (vfStatus) {
        vfStatus.textContent = 'Virtual-Files: Active';
        vfStatus.style.color = '#4caf50';
    }
    window.appendLocalLog('Virtual-files sandbox is ready!');
    
    const runVfBtn = document.getElementById('runVirtualButton') as HTMLButtonElement;
    if (runVfBtn) runVfBtn.disabled = false;
});

// Listen for the native fileschanged event
vfSandbox.addEventListener('fileschanged', (e: any) => {
    window.updateVirtualFilesView(e.detail);
});

// Populate presets dropdown
const select = document.getElementById('presetSelect');
if (!select) console.error("Select not found");
const customOption = select.querySelector('option[value="custom"]');
if (!customOption) console.error("Custom option not found");

console.log("Populating presets...");
Object.values(PRESETS).forEach(preset => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    select.insertBefore(option, customOption);
});
console.log("Presets populated");

window.appendLocalLog = (msg) => {
    // playground events added to logs
    appendLog({ source: 'playground', message: msg, level: 'log' });
};

// Listen for internal log events dispatch on window by host.ts
window.addEventListener('sandbox-log', (event) => {
    const data = event.detail;
    // Map Lofi log format to UI log format if needed
    // Lofi: { type: 'LOG', level: 'info', args: [...] }
    // UI expects: { level, message, source... }

    // Map 'info' to 'log' for UI compatibility
    if (data.level === 'info') data.level = 'log';

    const message = data.message || (data.args ? data.args.join(' ') : '');

    const sourceName = event.target === sandbox ? 'sandbox' : 'virtual-files-sandbox';
    const logEntry = {
        source: sourceName,
        level: data.level,
        message: message
    };
    capturedLogs.push(logEntry);
    appendLog(logEntry);
});

window.addEventListener('load', () => {
    const loaded = playground.loadState();
    if (!loaded) window.loadPreset(); // Load default if no saved state
    else window.applyNetworkRules(); // Apply rules from saved state
});
console.log("Added load listener");

function appendLog(data) {
    if (firstLog) {
        logsDiv.innerHTML = '';
        firstLog = false;
    }

    const div = document.createElement('div');
    div.className = 'log-entry';

    // Handle new LogMessage schema
    const source = data.source || data.depth || 'host';
    const level = data.level || data.logType || 'log';
    const message = data.message || (data.args ? data.args.join(' ') : '');
    const area = data.area || '';

    // Color based on level
    const isError = level === 'error';
    const badgeColor = isError ? '#ff5252' : (level === 'warn' ? '#ffb74d' : '#4caf50');

    const badge = document.createElement('span');
    badge.style.color = badgeColor;
    badge.textContent = `[${source}${area ? ':' + area : ''}] `;

    const content = document.createElement('span');
    content.style.color = isError ? '#ff5252' : 'inherit';
    content.textContent = message;

    div.appendChild(badge);
    div.appendChild(content);

    // Category styling
    if (area) {
        div.classList.add(`cat-${area}`);
    }

    logsDiv.prepend(div);

    // Tag for filtering
    if (window.playground && window.playground.tagLog) {
        const category = area === 'network' ? 'network' : (area === 'security' ? 'security' : (source === 'iframe-sandbox' ? 'user-code' : 'host'));
        window.playground.tagLog(div, category);
    }
}

window.loadPreset = () => {
    const val = document.getElementById('presetSelect').value;
    if (val === 'none') return;
    if (val === 'custom') {
        playground.loadState();
        return;
    }

    const preset = PRESETS[val];
    if (!preset) return;

    document.getElementById('rulesEditor').value = JSON.stringify(preset.rules, null, 2);
    document.getElementById('code').value = preset.code;

    window.applyNetworkRules();
    playground.saveState();
}

window.onCodeInput = () => {
    playground.triggerCustomMode();
    playground.saveState();
};

window.openTab = (evt: any, tabName: string) => {
    const contents = document.getElementsByClassName("tab-content");
    for (let i = 0; i < contents.length; i++) contents[i].classList.remove("active");
    
    const links = document.getElementsByClassName("tab-link");
    for (let i = 0; i < links.length; i++) links[i].classList.remove("active");
    
    const target = document.getElementById(tabName);
    if (target) target.classList.add("active");
    if (evt.currentTarget) evt.currentTarget.classList.add("active");
};

window.updateVirtualFilesView = (files: Record<string, string | Uint8Array>) => {
    const container = document.getElementById('virtual-files-tree');
    if (!container || !files || Object.keys(files).length === 0) return;

    const buildTree = (files: Record<string, any>) => {
        const root: any = {};
        Object.keys(files).forEach(path => {
            const parts = path.split('/').filter(Boolean);
            let current = root;
            parts.forEach((part, i) => {
                if (i === parts.length - 1) current[part] = { __file: true };
                else { current[part] = current[part] || {}; current = current[part]; }
            });
        });
        return root;
    };

    const render = (node: any): string => {
        const keys = Object.keys(node).sort((a, b) => {
            const aIsFile = !!node[a].__file;
            const bIsFile = !!node[b].__file;
            if (aIsFile !== bIsFile) return aIsFile ? 1 : -1;
            return a.localeCompare(b);
        });
        
        let html = '<ul>';
        keys.forEach(key => {
            const isFile = node[key].__file;
            html += `<li><span class="${isFile ? 'file' : 'folder'}">${isFile ? '📄' : '📁'} ${key}</span>`;
            if (!isFile) html += render(node[key]);
            html += '</li>';
        });
        return html + '</ul>';
    };

    container.innerHTML = render(buildTree(files));
};

window.runHtml = () => {
    const code = (document.getElementById('code') as HTMLTextAreaElement).value;
    if (sandbox && (sandbox as LofiSandbox).load) {
        (sandbox as LofiSandbox).load(code);
    }
};

window.onRulesBlur = () => {
    playground.triggerCustomMode();
    playground.saveState();
    window.debounceApplyRules();
};

let debounceTimer;
window.debounceApplyRules = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        window.applyNetworkRules();
    }, 500);
}

window.applyNetworkRules = () => {
    const rulesEditor = document.getElementById('rulesEditor');
    const rulesError = document.getElementById('rulesError');
    const rulesStr = rulesEditor.value;
    try {
        // Strip trailing commas to allow more relaxed JSON input
        const cleanedStr = rulesStr.replace(/,(\s*[\]}])/g, '$1');
        const rules = JSON.parse(cleanedStr);
        rulesEditor.classList.remove('error-border');
        rulesError.textContent = '';

        // Apply to both sandboxes
        (sandbox as LofiSandbox).setConfig(rules);
        
        const vfConfig = {
            ...rules,
            virtualFilesUrl: window.location.hostname === 'localhost'
                ? '/src/virtual-files'
                : 'http://virtual-files.localhost:4444'
        };
        (vfSandbox as LofiSandbox).setConfig(vfConfig);
        
        // Visual feedback that we are resetting the environment
        document.getElementById('sandbox-status').textContent = 'Sandbox: Initializing...';
        document.getElementById('sandbox-status').style.color = '#ffb74d';
        window.appendLocalLog('Applying configuration...');
        return true;


    } catch (e) {
        rulesEditor.classList.add('error-border');
        rulesError.textContent = 'Invalid JSON: ' + e.message;
        return false;
    }
}

window.runCode = () => {
    // Sync rules immediately
    window.applyNetworkRules();

    const code = (document.getElementById('code') as HTMLTextAreaElement).value;
    window.appendLocalLog('Executing code in sandbox...');
    (sandbox as LofiSandbox).execute(code);
}

window.runVirtualFiles = () => {
    window.applyNetworkRules();

    const code = (document.getElementById('code') as HTMLTextAreaElement).value;
    const vfSandboxEl = vfSandbox as LofiSandbox;

    window.appendLocalLog('Preparing virtual-files and executing...');

    try {
        // 1. Register the current code as index.html
        vfSandboxEl.registerFiles({
            'index.html': code
        });

        // 2. Bootstrap the sandbox from the virtual entry point
        vfSandboxEl.execute(`
            fetch('/index.html')
                .then(r => r.text())
                .then(html => {
                    document.open();
                    document.write(html);
                    document.close();
                });
        `);
    } catch (e) {
        window.appendLocalLog('Error during virtual-files execution: ' + e.message);
        console.error(e);
    }
}

window.clearLogs = () => {
    document.getElementById('logs').innerHTML = '';
}

window.resetSandbox = async () => {
    window.appendLocalLog('Resetting sandbox...');
    const runBtn = document.getElementById('runButton');
    if (runBtn) runBtn.disabled = true;
    // Clear host-side state
    localStorage.removeItem('safeSandbox_customState');
    // For LofiSandbox, we just re-initialize
    sandbox.setConfig({});
}

// Listen for reset completion from sandbox
window.addEventListener('message', (event) => {
    if (event.data?.type === 'RESET_COMPLETE') {
        window.location.reload(true);
    }
});

window.SandboxControl = {
    sandboxElement: sandbox,
    execute: (code) => {
        if (document.getElementById('sandbox-status').textContent !== 'Sandbox: Ready') {
            console.warn("SandboxControl: Execution blocked, sandbox not ready.");
            return;
        }
        sandbox.execute(code);
    },
    setConfig: (config) => {
        sandbox.setConfig(config);
    },
    getLogs: () => {
        return capturedLogs;
    },
    clearLogs: () => {
        capturedLogs.length = 0;
        document.getElementById('logs').innerHTML = '';
    }
};
console.log("SandboxControl exposed for automatic e2e testing");
