/**
 * Verification for the two kernel seams that make an EditorStore a document
 * runtime:
 *
 *   1. Bring-your-own-store — DOMDProvider `store` prop mounts the render
 *      surface onto an EXISTING store instead of constructing one, ignoring
 *      construction-time props. Verified through real server renders (the
 *      hook/provider path React actually runs), which also proves the
 *      always-on scroll memory hook is SSR-safe.
 *
 *   2. Scroll anchor store API — setScrollAnchor/scrollAnchor is an inert
 *      instance-field record: never wakes subscribers, never lands on the
 *      undo stack, lives independently of document state.
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-scroll-store/run.mts
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
    DOMD,
    DOMDProvider,
    EditorStore,
    useEditorStoreApi,
    type ScrollAnchor,
} from "@do-md/core-react";

let passed = 0;
const failures: string[] = [];

const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) {
        passed += 1;
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    }
};

// ---------------------------------------------------------------------------
// 1. Bring-your-own-store
// ---------------------------------------------------------------------------

{
    const external = new EditorStore({
        editable: true,
        initMd: "# External store heading",
    });

    let seen: EditorStore | null = null;
    const Probe = () => {
        seen = useEditorStoreApi();
        return null;
    };

    const html = renderToString(
        createElement(
            DOMDProvider,
            {
                store: external,
                // Construction-time props must be ignored when a store is given.
                initMd: "# DECOY should never render",
            },
            createElement(Probe),
            createElement(DOMD),
        ),
    );

    check(
        "BYO: provider hands out the exact external instance",
        seen === external,
    );
    check(
        "BYO: view renders the external store's document",
        html.includes("External store heading"),
    );
    check(
        "BYO: construction props are ignored when store is given",
        !html.includes("DECOY"),
    );

    // Default path unchanged: no store prop -> internal construction.
    let seenDefault: EditorStore | null = null;
    const ProbeDefault = () => {
        seenDefault = useEditorStoreApi();
        return null;
    };
    const htmlDefault = renderToString(
        createElement(
            DOMDProvider,
            { initMd: "# Internally constructed" },
            createElement(ProbeDefault),
            createElement(DOMD),
        ),
    );
    check(
        "default: without store prop a fresh store is constructed",
        seenDefault !== null && (seenDefault as unknown) !== external,
    );
    check(
        "default: view renders initMd",
        htmlDefault.includes("Internally constructed"),
    );

    // The same long-lived store mounted twice (the tabs flow: view remounts,
    // runtime survives) — second render must reflect edits made in between.
    external.insertText(" plus a later edit");
    const htmlRemount = renderToString(
        createElement(
            DOMDProvider,
            { store: external },
            createElement(DOMD),
        ),
    );
    check(
        "BYO: remounting over the live store shows its current state",
        htmlRemount.includes("plus a later edit"),
    );

    // SSR safety of the always-on scroll memory: rendering <DOMD/> on the
    // server (both renders above) not having thrown IS the assertion; count
    // it explicitly for the report.
    check("scroll memory hook is SSR-safe (renderToString ran)", true);
}

// ---------------------------------------------------------------------------
// 2. Scroll anchor store API
// ---------------------------------------------------------------------------

{
    const store = new EditorStore({ editable: true, initMd: "hello world" });

    check("anchor: starts null", store.scrollAnchor === null);

    const anchor: ScrollAnchor = {
        blockUuid: "block-1",
        blockDelta: -12.5,
        spanUuid: "span-1",
        spanDelta: 3,
    };

    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
        notifications += 1;
    });
    store.setScrollAnchor(anchor);
    check(
        "anchor: setScrollAnchor returns the same record",
        store.scrollAnchor === anchor,
    );
    check(
        "anchor: writing the anchor never wakes store subscribers",
        notifications === 0,
        `got ${notifications} notifications`,
    );
    unsubscribe();

    // Undo independence, both directions: an edit then anchor writes — undo
    // reverts the edit but the anchor stays; and the anchor write itself adds
    // nothing to the history stack.
    const mdBefore = store.toMarkdown();
    store.insertText("!");
    const mdAfterEdit = store.toMarkdown();
    check("anchor: sanity — insertText changed the doc", mdAfterEdit !== mdBefore);

    store.setScrollAnchor({ blockUuid: "block-2", blockDelta: 0 });
    store.undo();
    check(
        "anchor: undo reverts the edit ...",
        store.toMarkdown() === mdBefore,
        `got ${JSON.stringify(store.toMarkdown())}`,
    );
    check(
        "anchor: ... but never touches the anchor",
        store.scrollAnchor?.blockUuid === "block-2",
    );

    store.setScrollAnchor(null);
    check("anchor: null clears", store.scrollAnchor === null);
}

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error(`FAIL — ${failures.length} failed, ${passed} passed`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
}
console.log(`OK — all ${passed} assertions passed`);
