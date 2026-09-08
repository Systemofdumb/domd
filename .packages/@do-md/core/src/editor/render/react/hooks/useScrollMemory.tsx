import { useEffect, useLayoutEffect } from "react";
import { useEditorStoreApi } from "../../../store";
import { useEditorDom } from "./useEditorDom";
import type { ScrollAnchor } from "../../../type";

/** SSR-safe layout effect: restore must run before paint (no one-frame flash
 *  at scrollTop 0), but useLayoutEffect warns under server rendering. */
const useIsomorphicLayoutEffect =
    typeof window === "undefined" ? useEffect : useLayoutEffect;

/** A block whose bottom edge clears the viewport top by less than this is
 *  treated as fully scrolled past (guards sub-pixel rect jitter). */
const EDGE_EPSILON = 1;

/**
 * The one scrolling surface the hook talks to. Two shapes exist — a scrollable
 * ancestor element (host app layouts) and the document scroller (editor in
 * normal page flow) — and this seam makes the capture/restore logic identical
 * for both. `viewportTop` is read fresh on every use: an element container
 * itself moves when an outer scroller scrolls.
 */
interface Scroller {
    viewportTop: () => number;
    scrollTop: () => number;
    setScrollTop: (value: number) => void;
    maxScrollTop: () => number;
    /** Where scroll + interaction listeners attach. */
    eventTarget: EventTarget;
}

const elementScroller = (el: HTMLElement): Scroller => ({
    viewportTop: () => el.getBoundingClientRect().top,
    scrollTop: () => el.scrollTop,
    setScrollTop: (value) => {
        el.scrollTop = value;
    },
    maxScrollTop: () => el.scrollHeight - el.clientHeight,
    eventTarget: el,
});

const documentScroller = (): Scroller => {
    const doc = () => document.scrollingElement ?? document.documentElement;
    return {
        viewportTop: () => 0,
        scrollTop: () => doc().scrollTop,
        setScrollTop: (value) => {
            doc().scrollTop = value;
        },
        maxScrollTop: () => doc().scrollHeight - doc().clientHeight,
        eventTarget: window,
    };
};

/** Nearest scrollable ancestor of the editor root, or the document scroller
 *  when the editor lives in normal page flow. Resolved once on mount — a host
 *  that restructures its scroll containers remounts the editor anyway. */
const findScroller = (root: HTMLElement): Scroller => {
    let el = root.parentElement;
    while (el) {
        const { overflowY } = getComputedStyle(el);
        if (
            overflowY === "auto" ||
            overflowY === "scroll" ||
            overflowY === "overlay"
        ) {
            return elementScroller(el);
        }
        el = el.parentElement;
    }
    return documentScroller();
};

/**
 * lower_bound over elements whose bounding-rect bottoms are non-decreasing in
 * document order — true for block-flow siblings (border boxes never overlap
 * vertically) and for the inline spans inside one block (line boxes stack).
 * Returns the first element still (partly) visible at the viewport top, doing
 * O(log n) getBoundingClientRect calls instead of a linear sweep — a 20k-line
 * document resolves in ~11 rect reads per frame.
 */
const firstVisibleAt = (
    elements: Element[],
    viewportTop: number,
): Element | null => {
    let lo = 0;
    let hi = elements.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const bottom = elements[mid].getBoundingClientRect().bottom;
        if (bottom > viewportTop + EDGE_EPSILON) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo < elements.length ? elements[lo] : null;
};

/**
 * Scroll memory — always on, kernel-internal (mounted by `<DOMD />`).
 *
 * Reporting is effectively free: it runs at most once per frame and only
 * while scrolling, each capture is O(log n) rect reads (layout is clean
 * during scroll, so reads force no reflow), and the result lands in a plain
 * store instance field — no subscribers wake, nothing re-renders, the undo
 * stack never sees it. Hence no opt-out prop: the observable behavior is
 * "store.scrollAnchor is always current", nothing else.
 *
 * Mechanism (strictly one-directional, no sync):
 *
 * - **Reporting** — on every scroll (rAF-throttled) capture the first visible
 *   top-level block and the first visible text leaf inside it as a
 *   {@link ScrollAnchor} on the store. `visibilitychange → hidden` flushes
 *   one synchronous capture (rAF freezes in background tabs).
 *
 * - **Restore** — happens exactly once per view attach, and only when the
 *   store already carries an anchor (a long-lived store re-mounted by a tab
 *   switch, or an anchor the host re-injected from persistence before
 *   mounting). Resolved span-first (`data-span-render-id` survives block
 *   split/merge), block as fallback; if neither uuid exists in the DOM the
 *   restore is skipped silently — never a guess, never a jump. While large
 *   documents stream in through chunked parsing, unresolved anchors retry as
 *   blocks arrive (MutationObserver on the editor root); the first real user
 *   interaction closes the restore window for good, so a reading user is
 *   never yanked away. Later `setScrollAnchor` calls are records, not
 *   commands — the anchor never moves the viewport outside that window.
 */
export const useScrollMemory = () => {
    const store = useEditorStoreApi();
    const { textAreaDomRef } = useEditorDom();

    useIsomorphicLayoutEffect(() => {
        // The editor root is rendered by this same commit (RootElement lives
        // in the <DOMD /> subtree, and child refs attach before this layout
        // effect runs), so a missing root means "no editor surface" — bail.
        const root = textAreaDomRef.current;
        if (!root) return;
        const scroller = findScroller(root);

        let disposed = false;
        /** Scroll events our own setScrollTop writes are about to fire —
         *  consumed by the scroll handler so programmatic restores are never
         *  mistaken for user scrolling. */
        let suppressedScrolls = 0;
        let observer: MutationObserver | null = null;
        let restoring = store.scrollAnchor !== null;
        let captureQueued = false;
        let retryQueued = false;

        // ---- reporting --------------------------------------------------

        const capture = () => {
            const top = scroller.viewportTop();
            const blocks = Array.from(root.children).filter((el) =>
                el.hasAttribute("data-render-id"),
            );
            const block = firstVisibleAt(blocks, top);
            if (!block) {
                store.setScrollAnchor(null);
                return;
            }
            const anchor: ScrollAnchor = {
                blockUuid: block.getAttribute("data-render-id")!,
                blockDelta: block.getBoundingClientRect().top - top,
            };
            const spans = Array.from(
                block.querySelectorAll("[data-span-render-id]"),
            );
            const span = firstVisibleAt(spans, top);
            if (span) {
                anchor.spanUuid = span.getAttribute("data-span-render-id")!;
                anchor.spanDelta = span.getBoundingClientRect().top - top;
            }
            store.setScrollAnchor(anchor);
        };

        const scheduleCapture = () => {
            if (captureQueued) return;
            captureQueued = true;
            requestAnimationFrame(() => {
                captureQueued = false;
                if (!disposed && !restoring) capture();
            });
        };

        // ---- restore (mount window) -------------------------------------

        const endRestore = () => {
            if (!restoring) return;
            restoring = false;
            observer?.disconnect();
            observer = null;
            scroller.eventTarget.removeEventListener("wheel", endRestore);
            scroller.eventTarget.removeEventListener("touchstart", endRestore);
            scroller.eventTarget.removeEventListener("pointerdown", endRestore);
            scroller.eventTarget.removeEventListener("keydown", endRestore);
        };

        const resolveAnchor = (): { el: Element; delta: number } | null => {
            const anchor = store.scrollAnchor;
            if (!anchor) return null;
            if (anchor.spanUuid !== undefined) {
                const span = root.querySelector(
                    `[data-span-render-id="${CSS.escape(anchor.spanUuid)}"]`,
                );
                if (span) return { el: span, delta: anchor.spanDelta ?? 0 };
            }
            // The block lookup is not limited to top level: if edits moved
            // the block deeper (into a quote, a layout column), identity
            // still wins over position.
            const block = root.querySelector(
                `[data-render-id="${CSS.escape(anchor.blockUuid)}"]`,
            );
            if (block) return { el: block, delta: anchor.blockDelta };
            return null;
        };

        const tryRestore = (): boolean => {
            const resolved = resolveAnchor();
            if (!resolved) return false;
            const target =
                scroller.scrollTop() +
                (resolved.el.getBoundingClientRect().top -
                    scroller.viewportTop()) -
                resolved.delta;
            const clamped = Math.max(
                0,
                Math.min(target, scroller.maxScrollTop()),
            );
            // Suppress only when the write will actually fire a scroll event;
            // a no-op write would leave a stale suppression that swallows the
            // user's first real scroll.
            if (Math.abs(clamped - scroller.scrollTop()) >= 1) {
                suppressedScrolls += 1;
                scroller.setScrollTop(clamped);
            }
            endRestore();
            return true;
        };

        // ---- wiring -----------------------------------------------------

        const onScroll = () => {
            if (suppressedScrolls > 0) {
                suppressedScrolls -= 1;
                return;
            }
            if (restoring) endRestore();
            scheduleCapture();
        };

        // rAF freezes in hidden tabs: flush one synchronous capture when the
        // page goes to the background so the very last scroll before a
        // tab/app switch is not lost.
        const onVisibilityChange = () => {
            if (document.visibilityState !== "hidden") return;
            if (!disposed && !restoring) capture();
        };

        if (restoring && !tryRestore()) {
            // Anchor not in the DOM yet — either chunked parsing is still
            // streaming blocks in, or the content genuinely changed. Retry as
            // the tree fills; give up for good on the first real user
            // interaction.
            observer = new MutationObserver(() => {
                if (retryQueued) return;
                retryQueued = true;
                requestAnimationFrame(() => {
                    retryQueued = false;
                    if (!disposed && restoring) tryRestore();
                });
            });
            observer.observe(root, { childList: true, subtree: true });
            scroller.eventTarget.addEventListener("wheel", endRestore, {
                passive: true,
            });
            scroller.eventTarget.addEventListener("touchstart", endRestore, {
                passive: true,
            });
            scroller.eventTarget.addEventListener("pointerdown", endRestore);
            scroller.eventTarget.addEventListener("keydown", endRestore);
        }

        scroller.eventTarget.addEventListener("scroll", onScroll, {
            passive: true,
        });
        document.addEventListener("visibilitychange", onVisibilityChange);

        return () => {
            disposed = true;
            endRestore();
            scroller.eventTarget.removeEventListener("scroll", onScroll);
            document.removeEventListener(
                "visibilitychange",
                onVisibilityChange,
            );
        };
    }, [store, textAreaDomRef]);
};
