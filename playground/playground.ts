import "./state.ts"

import { LofiSandbox } from '@src/host.ts';
customElements.define("lofi-sandbox", LofiSandbox);

import { PRESETS } from '@src/lib/presets.ts';
// console.log("Imported PRESETS", PRESETS);

const capturedLogs = [];
const sandbox = document.getElementById('sandbox');
const logsDiv = document.getElementById('logs');
let firstLog = true;

console.log("Elements found:", sandbox, logsDiv);

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

    if (message === 'Iframe Ready' || message === 'Worker Ready') {
        document.getElementById('sandbox-status').textContent = 'Sandbox: Ready';
        document.getElementById('sandbox-status').style.color = '#4caf50';
        appendLocalLog('Sandbox is ready!');

        const runBtn = document.getElementById('runButton');
        if (runBtn) {
            runBtn.disabled = false;
        }
        return;
    }

    const logEntry = {
        source: 'iframe-sandbox',
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

        sandbox.setConfig(rules);
        
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

    const code = document.getElementById('code').value;
    window.appendLocalLog('Executing code ...');
    sandbox.execute(code);
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
