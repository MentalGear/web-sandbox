/**
 * Playground State & UI Utilities
 * Handles persistence, preset management, and log filtering.
 */

// Define the structure of the saved state
interface PlaygroundState {
    code: string;
    rules: string;
    timestamp: number;
}

// Define the public interface for the playground module
interface IPlayground {
    saveState(): void;
    loadState(): boolean;
    triggerCustomMode(): void;
    readonly currentFilter: string;
    setFilter(category: string): void;
    tagLog(element: HTMLElement, category: string): void;
}

// Declare the global `playground` object for TypeScript
declare global {
    interface Window {
        playground: IPlayground;
    }
}

class PlaygroundUIManager {
    private get presetSelect() { return document.getElementById("presetSelect") as HTMLSelectElement | null; }
    private get codeArea() { return document.getElementById("code") as HTMLTextAreaElement | null; }
    private get rulesEditor() { return document.getElementById("rulesEditor") as HTMLTextAreaElement | null; }
    private get logs() { return document.getElementById("logs") as HTMLElement | null; }

    public currentFilter: string = "all";

    /**
     * Saves the current playground state to localStorage (only if Custom).
     */
    public saveState(): void {
        if (!this.presetSelect || this.presetSelect.value !== "custom" || !this.codeArea || !this.rulesEditor) {
            localStorage.removeItem("safeSandbox_customState");
            return;
        }
        const state: PlaygroundState = {
            code: this.codeArea.value,
            rules: this.rulesEditor.value,
            timestamp: Date.now(),
        };
        localStorage.setItem("safeSandbox_customState", JSON.stringify(state));
    }

    /**
     * Loads saved state from localStorage.
     */
    public loadState(): boolean {
        const saved = localStorage.getItem("safeSandbox_customState");
        if (saved) {
            try {
                const state: PlaygroundState = JSON.parse(saved);
                if (this.codeArea) this.codeArea.value = state.code;
                if (this.rulesEditor) this.rulesEditor.value = state.rules;
                if (this.presetSelect) this.presetSelect.value = "custom";
                return true;
            } catch (e) {
                console.warn("Failed to load playground state:", e);
            }
        }
        return false;
    }

    /**
     * Switches the UI to Custom mode if human input is detected.
     */
    public triggerCustomMode(): void {
        if (this.presetSelect && this.presetSelect.value !== "custom") {
            this.presetSelect.value = "custom";
            this.saveState();
        }
    }

    /**
     * Filters the log view based on categories.
     */
    public setFilter(category: string): void {
        this.currentFilter = category;
        if (!this.logs) return;

        const entries = this.logs.getElementsByClassName("log-entry");

        // Update button styles
        document.querySelectorAll(".filter-btn").forEach((btn) => {
            const element = btn as HTMLElement;
            element.style.opacity = btn.id === `filter-${category}` ? "1" : "0.5";
            element.style.border =
                btn.id === `filter-${category}`
                    ? "1px solid var(--primary)"
                    : "1px solid transparent";
        });

        for (const entry of Array.from(entries)) {
            const entryCategory = entry.getAttribute("data-category");
            if (category === "all" || entryCategory === category) {
                (entry as HTMLElement).style.display = "block";
            } else {
                (entry as HTMLElement).style.display = "none";
            }
        }
    }

    /**
     * Adds category metadata to log entries for filtering.
     */
    public tagLog(element: HTMLElement, category: string): void {
        element.setAttribute("data-category", category);
        element.classList.add(`cat-${category}`);

        // Hide immediately if filter is active
        if (this.currentFilter !== "all" && this.currentFilter !== category) {
            element.style.display = "none";
        }
    }
}

// Instantiate the manager
const manager = new PlaygroundUIManager();

// Expose the public API on window.playground, maintaining the original contract
window.playground = {
    saveState: manager.saveState.bind(manager),
    loadState: manager.loadState.bind(manager),
    triggerCustomMode: manager.triggerCustomMode.bind(manager),
    setFilter: manager.setFilter.bind(manager),
    tagLog: manager.tagLog.bind(manager),
    get currentFilter(): string {
        return manager.currentFilter;
    },
};