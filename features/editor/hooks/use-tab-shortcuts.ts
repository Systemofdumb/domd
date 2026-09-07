"use client";
import { useEffect } from "react";
import { useTabStoreApi } from "../stores/tab-store";

/**
 * Tab navigation shortcuts.
 *
 * Cmd+N and Cmd+W are deliberately absent: both are native menu accelerators
 * (File ▸ New Window / Close Window, repointed at tabs), so Rust already
 * emits `menu-new-tab` / `menu-close-tab` for them. Handling them here too
 * would open or close two tabs per keypress wherever the key event also
 * reaches the webview. Only shortcuts with no menu counterpart live here.
 */
export function useTabShortcuts() {
    const store = useTabStoreApi();

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (!e.metaKey) return;

            const { tabs, activeTabId } = store.state;
            const activeIndex = tabs.findIndex((t) => t.id === activeTabId);

            // Cmd+Shift+] — next tab
            if (e.key === "]" && e.shiftKey) {
                e.preventDefault();
                const nextIndex = (activeIndex + 1) % tabs.length;
                store.activateTab(tabs[nextIndex].id);
                return;
            }

            // Cmd+Shift+[ — previous tab
            if (e.key === "[" && e.shiftKey) {
                e.preventDefault();
                const prevIndex =
                    (activeIndex - 1 + tabs.length) % tabs.length;
                store.activateTab(tabs[prevIndex].id);
                return;
            }

            // Cmd+1 through Cmd+9 — jump to tab by position
            const num = parseInt(e.key);
            if (num >= 1 && num <= 9) {
                e.preventDefault();
                const targetIndex = num === 9 ? tabs.length - 1 : num - 1;
                if (targetIndex < tabs.length) {
                    store.activateTab(tabs[targetIndex].id);
                }
                return;
            }
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [store]);
}
