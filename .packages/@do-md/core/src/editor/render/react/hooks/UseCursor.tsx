import { useEffect } from "react";
import {
    useEditorStore,
} from "../../../store";
import { useEditor } from "./useEditor";

export const UseCursor = () => {
    const cursorInfo = useEditorStore((s) => s.cursorInfo_);
    const editorController = useEditor();
    // The controller is in the deps deliberately: it arrives AFTER this
    // component's first effect (the provider constructs it per attached DOM,
    // in a parent effect that runs later), so keying on cursorInfo alone
    // would silently skip the replay for every view attach. The replay is
    // idempotent — when the attach protocol has already materialized the
    // selection (restoreViewState_), this pass sees the DOM in place and does
    // nothing.
    useEffect(() => {
        editorController?.replayCursor_();
    }, [cursorInfo, editorController]);

    return null;
};
