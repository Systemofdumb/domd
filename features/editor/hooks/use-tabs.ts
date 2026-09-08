"use client";
/**
 * Desktop tab machinery for the editor shell.
 *
 * Everything here is about which document is open and how documents enter and
 * leave the window. The editor itself is untouched: useDocumentLoaders reads
 * the active tab, so upstream's editor tree renders the active document and a
 * tab switch is just another document swap.
 *
 * Web never calls this — one page, one document, no tab bar.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@/common/lib/platform";
import { tauriCore, tauriDialog } from "@/common/lib/tauri";
import { useLatest } from "@/common/lib/use-latest";
import {
    blankTauriDoc,
    readTauriDoc,
    rereadTauriDoc,
} from "./use-document-loaders";
import { saveDocument } from "../lib/save-document";
import { useTabShortcuts } from "./use-tab-shortcuts";
import { useTauriEvent } from "./use-tauri-event";
import { useTabStore, useTabStoreApi } from "../stores/tab-store";

export function useTabs({
    enabled,
    onDocumentSwitch,
}: {
    /** Desktop only. Called unconditionally (hooks rule) and inert on web,
     *  where a window is one page holding one document. */
    enabled: boolean;
    /** Runs when the ACTIVE tab changes — the same teardown upstream does
     *  when a different document loads into the window (detachSharing). The
     *  live collaboration session belongs to the document that was showing,
     *  and only the active tab has a mounted editor to attach one to. */
    onDocumentSwitch: () => void;
}) {
    const { t } = useTranslation();
    const store = useTabStoreApi();
    const tabs = useTabStore((s) => s.state.tabs);
    const activeTabId = useTabStore((s) => s.state.activeTabId);
    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
    const onDocumentSwitchRef = useLatest(onDocumentSwitch);

    useTabShortcuts();

    /** Mirror the editor's unsaved-changes state onto the active tab so the
     *  tab bar can badge it. Stable identity — Editor stores it in a ref. */
    const markActiveTabDirty = useCallback(
        (isDirty: boolean) => {
            const id = store.state.activeTabId;
            if (id) store.markDirty(id, isDirty);
        },
        [store],
    );

    // ── Opening documents into tabs ──────────────────────────────────────
    /** Reuse the lone untouched blank tab if that is all the window has —
     *  opening a file from Finder should not leave an empty tab behind.
     *  (useTauriEvent ref-stores its handler, so this closure is always the
     *  current one without any extra indirection.) */
    const openPathInTab = async (path: string) => {
        const doc = await readTauriDoc(path);
        if (store.isOnlyBlankTab()) {
            store.replaceTabDoc(store.state.tabs[0].id, doc.meta, doc.content);
        } else {
            store.addTab(doc.meta, doc.content);
        }
        // Re-arm readiness for the CLI.
        //
        // `open_or_reuse` clears WindowReady before routing a file here,
        // because the window is about to show a different document and an
        // immediate `insert` must not land in the previous one. That relies on
        // something re-marking it, and until now the editor remount did.
        //
        // Reusing the lone blank tab no longer remounts anything: the runtime
        // is reset in place precisely so view state survives. So the tab layer
        // has to say when the document is actually in place — it is the only
        // party that knows, and it is true for both branches above.
        if (!isTauri()) return;
        const { invoke } = await tauriCore();
        await invoke("benchmark_mark_ready").catch(() => {});
    };

    useTauriEvent<string>("open-file-in-tab", (path) => {
        void openPathInTab(path);
    });

    useTauriEvent<string>("activate-tab", (path) => {
        const tab = store.findTabByPath(path);
        if (tab) store.activateTab(tab.id);
    });

    useTauriEvent("menu-new-tab", () => {
        window.dispatchEvent(new CustomEvent("domd-new-tab"));
    });

    useTauriEvent("menu-close-tab", () => {
        window.dispatchEvent(
            new CustomEvent("domd-close-tab", {
                detail: { tabId: store.state.activeTabId },
            }),
        );
    });

    /** Ask about a tab whose work would otherwise be lost, and report whether
     *  the caller may proceed. False means the user cancelled.
     *
     *  Only never-saved documents qualify: a path-backed one is already on
     *  disk (autosave wrote it), so closing it silently is correct. */
    const resolveUnsaved = useCallback(
        async (tabId: string): Promise<boolean> => {
            const tab = store.state.tabs.find((tb) => tb.id === tabId);
            if (!tab || !tab.isDirty) return true;
            if (tab.meta.kind !== "tauri" || tab.meta.path) return true;

            const { ask } = await tauriDialog();
            const shouldSave = await ask(
                t("tabs.unsavedBody", { name: tab.meta.name }),
                { title: t("tabs.unsavedTitle"), kind: "warning" },
            );
            if (!shouldSave) return true; // discard

            // One path for every tab: the runtime holds the live document
            // whether or not a view is attached, so a background tab needs no
            // snapshot and the active tab needs no detour through the mounted
            // editor's save handle. saveDocument opens the picker, and a
            // cancelled picker cancels the close.
            const result = await saveDocument(tab.meta, store.contentOf(tabId));
            if (result.ok) store.updateTabMeta(tabId, result.meta);
            return result.ok;
        },
        [store, t],
    );

    // ── New / close, driven by the tab bar, shortcuts and native menu ────
    useEffect(() => {
        if (!enabled) return;
        const handleNewTab = () => {
            const doc = blankTauriDoc();
            store.addTab(doc.meta, doc.content);
        };

        const handleCloseTab = (e: Event) => {
            const { tabId } = (e as CustomEvent).detail;
            if (!store.state.tabs.some((tb) => tb.id === tabId)) return;
            void (async () => {
                if (!(await resolveUnsaved(tabId))) return;
                if (store.closeTab(tabId) !== "last-tab") return;
                // Closing the only tab closes the window. Everything unsaved
                // has just been resolved, so skip the native sheet.
                const { invoke } = await tauriCore();
                await invoke("force_close_window").catch(() => {});
            })();
        };

        window.addEventListener("domd-new-tab", handleNewTab);
        window.addEventListener("domd-close-tab", handleCloseTab);
        return () => {
            window.removeEventListener("domd-new-tab", handleNewTab);
            window.removeEventListener("domd-close-tab", handleCloseTab);
        };
    }, [store, enabled, resolveUnsaved]);

    // ── A tab switch is a document switch ────────────────────────────────
    // Driven off the store subscription rather than an effect on activeTabId:
    // the teardown must run once per actual switch, keying on the tab id (not
    // the doc id) so switching between two never-saved documents still
    // detaches — and it is where the state below belongs too, since a
    // subscription callback is the sanctioned place to call setState.
    //
    // `switchedTabs` drives TabFocusOnSwitch, which puts real DOM focus on the
    // editor after a switch (see that component for why model-level focus is
    // not enough). Only this layer knows a mount came from a switch rather
    // than from opening the window's first document, and the empty -> first
    // tab transition is not a switch: guarding it keeps upstream's deliberate
    // no-autofocus behaviour on first load, and stops the initial load from
    // running a pointless collaboration teardown.
    const [switchedTabs, setSwitchedTabs] = useState(false);
    useEffect(
        () =>
            store.subscribe((next, prev) => {
                if (!prev.activeTabId) return;
                if (next.activeTabId === prev.activeTabId) return;
                setSwitchedTabs(true);
                onDocumentSwitchRef.current();
            }),
        [store, onDocumentSwitchRef],
    );

    // ── External writes to BACKGROUND tabs ───────────────────────────────
    // The active tab's own DiskReconciler handles its file; this only records
    // that a dormant tab's file moved (markPathStale skips the active tab).
    useTauriEvent<string>("file-changed", (path) => {
        store.markPathStale(path);
    });

    // Consume staleness when a tab returns to the foreground. A clean tab
    // adopts the disk content wholesale; a dirty one keeps its edits and asks
    // its (now mounted) reconciler for a forced pass, which splices the
    // external delta in rather than discarding either side.
    useEffect(() => {
        if (!enabled || !activeTab?.diskStale) return;
        const tabId = activeTab.id;
        if (activeTab.isDirty) {
            store.requestReconcile(tabId);
            return;
        }
        const meta = activeTab.meta;
        if (meta.kind !== "tauri" || !meta.path) {
            store.clearDiskStale(tabId);
            return;
        }
        const path = meta.path;
        let cancelled = false;
        void (async () => {
            const doc = await rereadTauriDoc(path);
            if (cancelled) return;
            if (!doc) {
                store.clearDiskStale(tabId);
                return;
            }
            store.replaceTabDoc(tabId, doc.meta, doc.content);
        })();
        return () => {
            cancelled = true;
        };
    }, [activeTab, store, enabled]);

    // ── Push open tab paths to Rust ──────────────────────────────────────
    // Feeds open_or_reuse (focus the window already showing a file and
    // activate its tab) and the file watcher (watch every open tab, not just
    // the window's last-assigned document).
    useEffect(() => {
        if (!enabled) return;
        const paths = tabs
            .map((tab) => (tab.meta.kind === "tauri" ? tab.meta.path : null))
            .filter((path): path is string => path !== null);
        tauriCore().then(({ invoke }) => {
            invoke("update_tabs", { paths }).catch(() => {});
        });
    }, [tabs, enabled]);

    // ── The window's assigned document follows the active tab ────────────
    // Drives the window title, and the close flow: Rust lets a window close
    // silently when it has an assigned path (a saved document autosaves) and
    // shows the native "save changes?" sheet when it does not. Leaving a
    // previously-saved tab's path behind while an untitled tab is active
    // would drop unsaved work without a prompt.
    const activeMeta = activeTab?.meta;
    const activePath =
        activeMeta?.kind === "tauri" ? (activeMeta.path ?? null) : null;
    useEffect(() => {
        if (!enabled) return;
        tauriCore().then(({ invoke }) => {
            if (activePath) {
                invoke("set_window_path", { path: activePath }).catch(() => {});
            } else {
                invoke("clear_window_path").catch(() => {});
            }
        });
    }, [activePath, enabled]);

    // ── Window close is left to Rust, deliberately ───────────────────────
    // There is NO onCloseRequested listener here, and adding one is a trap.
    // Tauri's JS wrapper is:
    //
    //     await handler(evt);
    //     if (!evt.isPreventDefault()) await this.destroy();
    //
    // Registering a listener therefore moves responsibility for actually
    // destroying the window into JavaScript, while the Rust close handler
    // (lib.rs, WindowEvent::CloseRequested — the native "save changes?"
    // sheet) is still running its own flow. A handler that prevents, throws,
    // or simply never finishes leaves the window with nobody left to close
    // it: the red button stops working entirely, which is far worse than the
    // edge case such a listener would be guarding.
    //
    // So the close button behaves exactly as upstream does. The residual gap
    // is a background tab holding NEVER-SAVED work when the window closes:
    // the native sheet can only speak for the active document. Closing that
    // tab directly does prompt (see resolveUnsaved above), which is the path
    // people actually take, and saved documents are never at risk because
    // autosave and the switch-time flush have already written them.

    return { markActiveTabDirty, switchedTabs };
}
