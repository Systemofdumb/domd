import { nanoid } from "@do-md/utils";
import { ZenithStore, createReactStore } from "@do-md/zenith";
import type { FileMeta, Tab, TabStoreState } from "../lib/types";

const makeTab = (meta: FileMeta, content: string): Tab => ({
    id: nanoid(),
    meta,
    content,
    scrollTop: 0,
    isDirty: false,
    diskStale: false,
    reconcileEpoch: 0,
    docEpoch: 0,
});

/**
 * The open documents of one window.
 *
 * This is the document source for BOTH runtimes, not just the tabbed one:
 * useDocumentLoaders reads the active tab and writes through this store, so
 * the web shell is simply the case where nothing ever opens a second tab.
 * Keeping one path means upstream's editor tree stays the only editor tree —
 * features added there work under tabs without being mirrored.
 *
 * Starts EMPTY: the document is resolved in a mount effect (the static export
 * cannot know at build time whether it is opening a file, a draft or a blank
 * doc), and no tabs is exactly the "loading" view.
 */
export class TabStore extends ZenithStore<TabStoreState> {
    constructor() {
        super({ tabs: [], activeTabId: "", displayMode: "shrink" });
    }

    get activeTab(): Tab | undefined {
        return this.state.tabs.find((t) => t.id === this.state.activeTabId);
    }

    /** Load a document into the ACTIVE tab, creating the first tab if the
     *  window has none yet. This is the single-document path — what every
     *  useDocumentLoaders entry point does, and what the web shell only ever
     *  does. Opening a document in a NEW tab is `addTab`. */
    openInActiveTab(meta: FileMeta, content: string): string {
        const current = this.activeTab;
        if (!current) {
            const tab = makeTab(meta, content);
            this.produce((draft) => {
                draft.tabs.push(tab);
                draft.activeTabId = tab.id;
            });
            return tab.id;
        }
        this.replaceTabDoc(current.id, meta, content);
        return current.id;
    }

    /** Returns the id of the tab now showing this document — either a newly
     *  created one, or the existing tab it deduped into. */
    addTab(meta: FileMeta, content: string): string {
        // Dedup: if a tab with the same path is already open, activate it
        if (meta.kind === "tauri" && meta.path) {
            const existing = this.state.tabs.find(
                (t) => t.meta.kind === "tauri" && t.meta.path === meta.path,
            );
            if (existing) {
                this.activateTab(existing.id);
                return existing.id;
            }
        }

        const tab = makeTab(meta, content);
        this.produce((draft) => {
            draft.tabs.push(tab);
            draft.activeTabId = tab.id;
        });
        return tab.id;
    }

    closeTab(tabId: string): "closed" | "last-tab" {
        const { tabs } = this.state;
        if (tabs.length <= 1) {
            return "last-tab";
        }

        const index = tabs.findIndex((t) => t.id === tabId);
        if (index === -1) return "closed";

        this.produce((draft) => {
            draft.tabs.splice(index, 1);
            if (draft.activeTabId === tabId) {
                // Activate neighbor: prefer right, fallback left
                const nextIndex = Math.min(index, draft.tabs.length - 1);
                draft.activeTabId = draft.tabs[nextIndex].id;
            }
        });
        return "closed";
    }

    activateTab(tabId: string) {
        if (tabId === this.state.activeTabId) return;
        this.produce((draft) => {
            draft.activeTabId = tabId;
        });
    }

    reorderTab(fromIndex: number, toIndex: number) {
        if (fromIndex === toIndex) return;
        this.produce((draft) => {
            const [moved] = draft.tabs.splice(fromIndex, 1);
            draft.tabs.splice(toIndex, 0, moved);
        });
    }

    updateTabMeta(tabId: string, meta: FileMeta) {
        this.produce((draft) => {
            const tab = draft.tabs.find((t) => t.id === tabId);
            if (tab) tab.meta = meta;
        });
    }

    updateTabContent(tabId: string, content: string, scrollTop: number) {
        this.produce((draft) => {
            const tab = draft.tabs.find((t) => t.id === tabId);
            if (tab) {
                tab.content = content;
                tab.scrollTop = scrollTop;
            }
        });
    }

    /** Replace a tab's document wholesale after an external edit (clean tabs
     *  only — see rereadTauriPathDoc). Bumping docEpoch re-keys the editor so
     *  the new content is actually loaded, and invalidates the outgoing
     *  editor's write-back so it cannot restore what we just replaced. */
    replaceTabDoc(tabId: string, meta: FileMeta, content: string) {
        this.produce((draft) => {
            const tab = draft.tabs.find((t) => t.id === tabId);
            if (!tab) return;
            tab.meta = meta;
            tab.content = content;
            tab.scrollTop = 0;
            tab.isDirty = false;
            tab.diskStale = false;
            tab.docEpoch += 1;
        });
    }

    /** The tab's current docEpoch, or null when the tab is gone. Used by the
     *  unmounting editor to check that its write-back is still valid. */
    docEpochOf(tabId: string): number | null {
        return this.state.tabs.find((t) => t.id === tabId)?.docEpoch ?? null;
    }

    markDirty(tabId: string, dirty: boolean) {
        this.produce((draft) => {
            const tab = draft.tabs.find((t) => t.id === tabId);
            if (tab) tab.isDirty = dirty;
        });
    }

    /** Flag every BACKGROUND tab bound to this path as needing a disk
     *  re-read. The active tab is skipped: its mounted DiskReconciler
     *  already handles `file-changed` for the live document. */
    markPathStale(path: string) {
        this.produce((draft) => {
            for (const tab of draft.tabs) {
                if (tab.id === draft.activeTabId) continue;
                if (tab.meta.kind === "tauri" && tab.meta.path === path) {
                    tab.diskStale = true;
                }
            }
        });
    }

    clearDiskStale(tabId: string) {
        this.produce((draft) => {
            const tab = draft.tabs.find((t) => t.id === tabId);
            if (tab) tab.diskStale = false;
        });
    }

    /** Ask the tab's mounted reconciler for a forced pass, and clear the
     *  stale flag now that it has been handed off. */
    requestReconcile(tabId: string) {
        this.produce((draft) => {
            const tab = draft.tabs.find((t) => t.id === tabId);
            if (!tab) return;
            tab.reconcileEpoch += 1;
            tab.diskStale = false;
        });
    }

    setDisplayMode(mode: "shrink" | "scroll") {
        this.produce((draft) => {
            draft.displayMode = mode;
        });
    }

    findTabByPath(path: string): Tab | undefined {
        return this.state.tabs.find(
            (t) => t.meta.kind === "tauri" && t.meta.path === path,
        );
    }

    isOnlyBlankTab(): boolean {
        const { tabs } = this.state;
        if (tabs.length !== 1) return false;
        const tab = tabs[0];
        return (
            tab.meta.kind === "tauri" &&
            tab.meta.path === null &&
            tab.content === "" &&
            !tab.isDirty
        );
    }
}

export const {
    StoreProvider: TabStoreProvider,
    useStore: useTabStore,
    useStoreApi: useTabStoreApi,
} = createReactStore(TabStore);
