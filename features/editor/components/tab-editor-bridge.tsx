"use client";
import { useEffect, useRef } from "react";
import { toMarkdown, useRenderData } from "@do-md/core-react";
import { useLatest } from "@/common/lib/use-latest";
import { saveDocument } from "../lib/save-document";
import { useTabStoreApi } from "../stores/tab-store";

/**
 * Lives inside the editor's provider. Only the ACTIVE tab has a mounted
 * editor, so this is where a tab's live state is written back before it goes
 * dormant: on unmount (a tab switch or close) it serializes the document and
 * scroll position into the TabStore, and flushes a save to disk.
 *
 * The flush matters because auto-save is debounced 600ms and dies with the
 * unmount — switching tabs right after typing would otherwise drop the last
 * edits from the file. They would survive in the store, but a tab that looks
 * saved and is not on disk is exactly the bug tabs must not introduce. Only
 * path-backed documents are flushed: a pathless one would pop a save dialog,
 * unacceptable as a side effect of switching tabs.
 *
 * Identity comes from the store rather than props: this component is bound to
 * whichever document its provider was mounted for, and that is precisely the
 * (tab, docEpoch) pair the store held at mount.
 */
export function TabEditorBridge() {
    const renderData = useRenderData();
    const store = useTabStoreApi();
    const renderDataRef = useLatest(renderData);

    // Captured once: the document this editor instance belongs to. The
    // provider is keyed on both, so a change to either remounts us.
    const boundRef = useRef({
        tabId: store.state.activeTabId,
        docEpoch: store.docEpochOf(store.state.activeTabId),
    });

    // Restore scroll position on mount.
    useEffect(() => {
        const { tabId } = boundRef.current;
        const tab = store.state.tabs.find((t) => t.id === tabId);
        if (!tab || tab.scrollTop <= 0) return;
        const target = tab.scrollTop;
        const raf = requestAnimationFrame(() => {
            const scroller = document.querySelector(
                "[data-tab-scroll-container]",
            );
            if (scroller) scroller.scrollTop = target;
        });
        return () => cancelAnimationFrame(raf);
    }, [store]);

    // On unmount: serialize content + scroll back to the store, then flush.
    // The refs are read in the cleanup ON PURPOSE — the point is to capture
    // the document as it stands when the tab goes dormant, not as it stood
    // when the effect was set up.
    useEffect(() => {
        const latestRenderData = renderDataRef;
        const bound = boundRef.current;
        return () => {
            // Superseded by a disk re-read (or the tab is gone): our buffer is
            // stale and must not be written back over what replaced it.
            if (store.docEpochOf(bound.tabId) !== bound.docEpoch) return;

            const md = toMarkdown(latestRenderData.current) ?? "";
            const scroller = document.querySelector(
                "[data-tab-scroll-container]",
            );
            store.updateTabContent(
                bound.tabId,
                md,
                scroller?.scrollTop ?? 0,
            );

            const tab = store.state.tabs.find((t) => t.id === bound.tabId);
            const meta = tab?.meta;
            if (!meta || meta.kind !== "tauri" || !meta.path) return;
            // saveDocument dedupes byte-identical writes against the
            // known-disk-content registry, so a clean switch costs nothing.
            void saveDocument(meta, md).then((result) => {
                if (result.ok) store.markDirty(bound.tabId, false);
            });
        };
    }, [store, renderDataRef]);

    return null;
}
