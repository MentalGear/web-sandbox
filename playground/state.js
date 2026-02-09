/**
 * Playground State & UI Utilities
 * Handles persistence, preset management, and log filtering.
 */

window.playground = {
    /**
     * Saves the current playground state to localStorage (only if Custom).
     */
    saveState() {
        const preset = document.getElementById("presetSelect").value
        if (preset !== "custom") {
            localStorage.removeItem("safeSandbox_customState")
            return
        }

        const state = {
            code: document.getElementById("code").value,
            rules: document.getElementById("rulesEditor").value,
            timestamp: Date.now(),
        }
        localStorage.setItem("safeSandbox_customState", JSON.stringify(state))
    },

    /**
     * Loads saved state from localStorage.
     */
    loadState() {
        const saved = localStorage.getItem("safeSandbox_customState")
        if (saved) {
            try {
                const state = JSON.parse(saved)
                document.getElementById("code").value = state.code
                document.getElementById("rulesEditor").value = state.rules
                document.getElementById("presetSelect").value = "custom"
                return true
            } catch (e) {
                console.warn("Failed to load playground state:", e)
            }
        }
        return false
    },

    /**
     * Switches the UI to Custom mode if human input is detected.
     */
    triggerCustomMode() {
        const select = document.getElementById("presetSelect")
        if (select.value !== "custom") {
            select.value = "custom"
            this.saveState()
        }
    },

    /**
     * Filters the log view based on categories.
     */
    // currentFilter: "all",
    // setFilter(category) {
    //     this.currentFilter = category
    //     const logs = document.getElementById("logs")
    //     const entries = logs.getElementsByClassName("log-entry")

    //     // Update button styles
    //     document.querySelectorAll(".filter-btn").forEach((btn) => {
    //         btn.style.opacity = btn.id === `filter-${category}` ? "1" : "0.5"
    //         btn.style.border =
    //             btn.id === `filter-${category}`
    //                 ? "1px solid var(--primary)"
    //                 : "1px solid transparent"
    //     })

    //     for (const entry of entries) {
    //         const entryCategory = entry.getAttribute("data-category")
    //         if (category === "all" || entryCategory === category) {
    //             entry.style.display = "block"
    //         } else {
    //             entry.style.display = "none"
    //         }
    //     }
    // },

    /**
     * Adds category metadata to log entries for filtering.
     */
    tagLog(element, category) {
        element.setAttribute("data-category", category)
        element.classList.add(`cat-${category}`)

        // Hide immediately if filter is active
        if (this.currentFilter !== "all" && this.currentFilter !== category) {
            element.style.display = "none"
        }
    },
}
