export type FileMeta =
    | {
          kind: "tauri";
          path: string | null;
          name: string;
          /** Frontmatter `domd-id` — the document's cross-device identity.
           *  Established on open (silently injected when missing) or on the
           *  first save of a new document. */
          docId?: string | null;
          /** Raw frontmatter block (delimiters included, trailing "\n").
           *  Stripped from the editor content on load and re-prepended on
           *  every save so the kernel never sees it. */
          frontmatter?: string | null;
      }
    | {
          kind: "web";
          name: string;
          handle: FileSystemFileHandle | null;
          dirHandle?: FileSystemDirectoryHandle | null;
      };

export type View = "loading" | "editor";

export interface Tab {
    id: string;
    meta: FileMeta;
    /** Body markdown WITHOUT the frontmatter block (that lives in `meta`).
     *  Authoritative only while the tab is in the background — the mounted
     *  tab's editor is the source of truth, and TabEditorBridge writes back
     *  here on unmount. */
    content: string;
    scrollTop: number;
    isDirty: boolean;
    /** Set when the file watcher reported an external write while this tab
     *  was NOT mounted. Consumed on activation: a clean tab re-reads from
     *  disk wholesale, a dirty tab gets a forced reconcile pass once its
     *  editor mounts (see TabEditorSwitch). */
    diskStale: boolean;
    /** Bumped to force the mounted DiskReconciler to run a pass — reuses the
     *  same trigger mechanism as the collab attach. */
    reconcileEpoch: number;
    /** Bumped whenever `content` is replaced out-of-band (a disk re-read).
     *  Part of the editor's mount key, so the new content actually reaches
     *  the kernel via initMd; also invalidates the outgoing editor's
     *  write-back so it cannot clobber what we just adopted. */
    docEpoch: number;
}

export interface TabStoreState {
    tabs: Tab[];
    activeTabId: string;
    displayMode: "shrink" | "scroll";
}
