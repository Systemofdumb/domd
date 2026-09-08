import { ParentRenderData } from "../../../../../../type";
import styles from "../../../../../../style/DOMD.module.css";
import Renderer from "../../index";
import { useEditorStore } from "../../../../../../store";
import { EditorDomContext } from "../../../../context";
import { MarkdownType } from "../../../../../../type/enum";
import { useContext } from "react";
import { memo } from "react";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";

interface Props {
    parsedData: ParentRenderData;
}
function RootElement({ parsedData }: Props) {
    const isEditable = useEditorStore((store) => store.isEditable);
    const domContext = useContext(EditorDomContext);
    const props = getRenderElementProps(parsedData);
    return (
        <div
            {...props}
            data-domd-root=""
            // Mount through the provider's ref sink so the controller can
            // rebind when the view detaches and re-attaches over a live
            // store; the plain ref object is the legacy fallback for context
            // values that predate the sink.
            ref={domContext?.attachTextAreaDom_ ?? domContext?.textAreaDomRef}
            contentEditable={isEditable}
            spellCheck={false}
            tabIndex={0}
        >
            {parsedData.children_.map((child) => (
                <Renderer key={child.uuid_} parsedData={child} />
            ))}
        </div>
    );
}

export default memo(RootElement);
