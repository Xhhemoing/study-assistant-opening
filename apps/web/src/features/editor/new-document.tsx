"use client";

import { FilePlus2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createEditorApi, type EditorDocument } from "./editor-api";
import { createSingleFlight } from "./single-flight";
import { createEmptyLocalDraft } from "./local-draft";
import { DEFAULT_LIBRARY_BASE_PATH, libraryNotePath, type LibraryBasePath } from "./library-paths";

export function NewDocument({ basePath = DEFAULT_LIBRARY_BASE_PATH }: { basePath?: LibraryBasePath }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  // StrictMode re-runs this effect with the same attempt; join the in-flight
  // POST instead of creating a second empty note (G5). Retry bumps attempt.
  const flight = useRef(createSingleFlight<EditorDocument>());

  useEffect(() => {
    let active = true;
    flight.current.run(attempt, () => {
      const draft = createEmptyLocalDraft();
      return createEditorApi().createDocument({
      title: draft.title,
      blocks: draft.blocks.map(({ id, type, content }) => ({
        id,
        type,
        content: { blockNoteContent: content, props: null, children: [] },
      })),
      });
    }).then((document) => {
      if (active) router.replace(libraryNotePath(basePath, document.id));
    }).catch(() => {
      if (active) setError("暂时无法创建笔记，请稍后重试。");
    });
    return () => { active = false; };
  }, [attempt, basePath, router]);

  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6 py-12">
      <div className="grid max-w-sm justify-items-center gap-4 text-center">
        {error ? <><FilePlus2 aria-hidden="true" className="text-red-700" size={24} /><p className="text-sm text-red-700" role="alert">{error}</p><button className="inline-flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50" type="button" onClick={() => { setError(""); setAttempt((value) => value + 1); }}><RefreshCw aria-hidden="true" size={16} />重试</button></> : <><FilePlus2 aria-hidden="true" className="text-emerald-700" size={24} /><p className="text-sm text-zinc-500" role="status">正在创建笔记...</p></>}
      </div>
    </main>
  );
}
