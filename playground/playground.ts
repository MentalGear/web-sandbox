import "./playground-state.ts"

import { WebSandbox, defineWebSandbox } from '@src/host.ts';
defineWebSandbox();

import { SandboxDevTools } from '@src/devtools.ts';
import { PRESETS, type Preset } from '@src/lib/presets.ts';
import type { SandboxConfig } from '@src/host.ts';

// -----------------

interface LogEntry {
    source?: string;
    level?: string;
    message?: string;
    args?: unknown[];
    area?: string;
    depth?: string; // older log schema
    logType?: string; // older log schema
}

// Functions the playground's inline HTML handlers (onclick, oninput, ...) and the e2e tests call
declare global {
    interface Window {
        appendLocalLog(msg: string): void;
        loadPreset(): void;
        onCodeInput(): void;
        onRulesBlur(): void;
        openTab(evt: Event, tabName: string): void;
        updateVirtualFilesView(): void;
        runHtml(): void;
        runCode(): void;
        runVirtualFiles(): void;
        debounceApplyRules(): void;
        applyNetworkRules(): boolean;
        clearLogs(): void;
        resetSandbox(): Promise<void>;
        SandboxControl: {
            sandboxElement: WebSandbox;
            execute(code: string): void;
            setConfig(config: SandboxConfig): void;
            getLogs(): LogEntry[];
            clearLogs(): void;
        };
    }
}

// Every element the playground uses is in index.html: a missing one is a bug, so fail loudly
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Playground element #${id} is missing`);
    return element as T;
}

const DEFAULT_PRESET = 'basic';

const capturedLogs: LogEntry[] = [];
const sandbox = byId<WebSandbox>('sandbox');
const vfSandbox = byId<WebSandbox>('virtual-files-sandbox');
const logsDiv = byId('logs');
let firstLog = true;

console.log("Elements found:", sandbox, logsDiv);

// Initialize DevTools
// We attach devtools to the virtual-files sandbox as it's more relevant there
const devtools = new SandboxDevTools(vfSandbox);
const toggleBtn = document.getElementById('toggleDevTools');
if (toggleBtn) {
    toggleBtn.onclick = () => devtools.toggle();
}

// Listen for readiness on the sandbox elements directly
sandbox.addEventListener('ready', () => {
    byId('sandbox-status').textContent = 'Sandbox: Ready';
    byId('sandbox-status').style.color = '#4caf50';
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

// fileschanged carries only the changed paths; the tree is rebuilt from the element's own list
vfSandbox.addEventListener('fileschanged', () => {
    window.updateVirtualFilesView();
});

// Populate presets dropdown
const select = byId<HTMLSelectElement>('presetSelect');
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

window.appendLocalLog = (msg: string) => {
    // playground events added to logs
    appendLog({ source: 'playground', message: msg, level: 'log' });
};

// Log events are dispatched on each sandbox element and bubble up to window; event.target names the sandbox
window.addEventListener('sandbox-log', (event) => {
    const data = (event as CustomEvent<LogEntry>).detail;
    // Map sandbox log format to UI log format if needed
    // Sandbox: { type: 'LOG', level: 'info', args: [...] }
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
    const loaded = window.playground.loadState();
    if (loaded) {
        window.applyNetworkRules(); // Apply rules from saved state
        return;
    }

    // Load default if no saved state. The select starts on its "none" placeholder,
    // which loadPreset() ignores, so pick the default preset first.
    if (select.value === 'none') select.value = DEFAULT_PRESET;
    window.loadPreset();
});
console.log("Added load listener");

function appendLog(data: LogEntry) {
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
    const val = select.value;
    if (val === 'none') return;
    if (val === 'custom') {
        window.playground.loadState();
        return;
    }

    const preset: Preset | undefined = PRESETS[val as keyof typeof PRESETS];
    if (!preset) return;

    byId<HTMLTextAreaElement>('rulesEditor').value = JSON.stringify(preset.rules, null, 2);
    byId<HTMLTextAreaElement>('code').value = preset.code;

    // Files are part of the environment: replace the previous preset's files on both sandboxes before
    // applyNetworkRules() rebuilds them, so "Run Code", "Run as HTML" and "Run (Virtual-Files)" all see them.
    for (const element of [sandbox, vfSandbox]) {
        element.unregisterFiles();
        element.registerFiles(preset.files ?? {});
    }

    window.applyNetworkRules();
    window.playground.saveState();
}

window.onCodeInput = () => {
    window.playground.triggerCustomMode();
    window.playground.saveState();
};

window.openTab = (evt: Event, tabName: string) => {
    const contents = document.getElementsByClassName("tab-content");
    for (const content of Array.from(contents)) content.classList.remove("active");
    
    const links = document.getElementsByClassName("tab-link");
    for (const link of Array.from(links)) link.classList.remove("active");
    
    const target = document.getElementById(tabName);
    if (target) target.classList.add("active");
    if (evt.currentTarget instanceof HTMLElement) evt.currentTarget.classList.add("active");
};

window.updateVirtualFilesView = () => {
    const container = document.getElementById('virtual-files-tree');
    if (!container) return;
    const paths = vfSandbox.listFiles().map(file => file.path);
    if (paths.length === 0) {
        container.innerHTML = '<div style="color: #555; font-style: italic;">No virtual files registered yet.</div>';
        return;
    }

    const buildTree = (paths: string[]) => {
        const root: any = {};
        paths.forEach(path => {
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

    container.innerHTML = render(buildTree(paths));
};

window.runHtml = () => {
    sandbox.load(byId<HTMLTextAreaElement>('code').value);
};

window.onRulesBlur = () => {
    window.playground.triggerCustomMode();
    window.playground.saveState();
    window.debounceApplyRules();
};

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
window.debounceApplyRules = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        window.applyNetworkRules();
    }, 500);
}

window.applyNetworkRules = () => {
    const rulesEditor = byId<HTMLTextAreaElement>('rulesEditor');
    const rulesError = byId('rulesError');
    const rulesStr = rulesEditor.value;
    try {
        // Strip trailing commas to allow more relaxed JSON input
        const cleanedStr = rulesStr.replace(/,(\s*[\]}])/g, '$1');
        const rules = JSON.parse(cleanedStr);
        rulesEditor.classList.remove('error-border');
        rulesError.textContent = '';

        // Apply to both sandboxes
        sandbox.setConfig(rules);
        
        vfSandbox.setConfig(rules);
        
        // Visual feedback that we are resetting the environment
        byId('sandbox-status').textContent = 'Sandbox: Initializing...';
        byId('sandbox-status').style.color = '#ffb74d';
        window.appendLocalLog('Applying configuration...');
        return true;


    } catch (e) {
        rulesEditor.classList.add('error-border');
        rulesError.textContent = 'Invalid JSON: ' + (e as Error).message;
        return false;
    }
}

window.runCode = () => {
    // Sync rules immediately
    window.applyNetworkRules();

    const code = byId<HTMLTextAreaElement>('code').value;
    window.appendLocalLog('Executing code in sandbox...');
    sandbox.execute(code);
}

window.runVirtualFiles = () => {
    window.applyNetworkRules();

    const code = byId<HTMLTextAreaElement>('code').value;
    const vfSandboxEl = vfSandbox;

    window.appendLocalLog('Registering the code as index.html and loading it...');

    try {
        // The code becomes a file next to the preset's files (readable as sandboxFiles.text('index.html'))
        // and is loaded as the guest's markup. Markup that references other files by path resolves in
        // a later step (backlog C1); until then guest code uses sandboxFiles.url().
        vfSandboxEl.registerFiles({ 'index.html': code });
        vfSandboxEl.load(code);
    } catch (e) {
        window.appendLocalLog('Error during virtual-files execution: ' + (e as Error).message);
        console.error(e);
    }
}

window.clearLogs = () => {
    logsDiv.innerHTML = '';
}

window.resetSandbox = async () => {
    window.appendLocalLog('Resetting sandbox...');
    byId<HTMLButtonElement>('runButton').disabled = true;
    // Clear host-side state
    localStorage.removeItem('safeSandbox_customState');
    // For WebSandbox, we just re-initialize
    sandbox.setConfig({});
}

// Listen for reset completion from sandbox
window.addEventListener('message', (event) => {
    if (event.data?.type === 'RESET_COMPLETE') {
        window.location.reload();
    }
});

window.SandboxControl = {
    sandboxElement: sandbox,
    execute: (code: string) => {
        if (byId('sandbox-status').textContent !== 'Sandbox: Ready') {
            console.warn("SandboxControl: Execution blocked, sandbox not ready.");
            return;
        }
        sandbox.execute(code);
    },
    setConfig: (config: SandboxConfig) => {
        sandbox.setConfig(config);
    },
    getLogs: () => {
        return capturedLogs;
    },
    clearLogs: () => {
        capturedLogs.length = 0;
        logsDiv.innerHTML = '';
    }
};
console.log("SandboxControl exposed for automatic e2e testing");
