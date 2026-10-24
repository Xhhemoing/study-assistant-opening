"use client";

import { FilePlus2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { TransitionLink as Link } from "../opening/v3/motion/view-transition";
import { useEffect, useRef, useState } from "react";
import { createEditorApi, EditorApiError, type EditorDocument } from "./editor-api";
import { createSingleFlight } from "./single-flight";
import { createEmptyLocalDraft } from "./local-draft";
import { DEFAULT_LIBRARY_BASE_PATH, libraryNotePath, type LibraryBasePath } from "./library-paths";

export function NewDocument({ basePath = DEFAULT_LIBRARY_BASE_PATH }: { basePath?: LibraryBasePath }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  const [unknown, setUnknown] = useState(false);

  // StrictMode re-runs this effect with the same attempt; join the in-flight
  // POST instead of creating a second empty note (G5). Retry bumps attempt.
  const flight = useRef(createSingleFlight<EditorDocument>());

  useEffect(() => {
    let active = true;
    setSlow(false); setUnknown(false);
    const timeout = window.setTimeout(() => { if (active) setSlow(true); }, 20_000);
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
      window.clearTimeout(timeout);
      if (active) router.replace(libraryNotePath(basePath, document.id));
    }).catch((failure: unknown) => {
      window.clearTimeout(timeout);
      if (!active) return;
      const unconfirmed = !(failure instanceof EditorApiError) || failure.status >= 500;
      setUnknown(unconfirmed);
      setError(unconfirmed ? "创建结果尚未确认，请先到知识库检查，避免重复创建。" : "暂时无法创建笔记，请稍后重试。");
    });
    return () => { active = false; window.clearTimeout(timeout); };
  }, [attempt, basePath, router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6 py-12">
      <div className="grid max-w-sm justify-items-center gap-4 text-center">
        {error ? <><FilePlus2 aria-hidden="true" className="text-danger" size={24} /><p className="text-sm text-danger" role="alert">{error}</p>{!unknown ? <button className="inline-flex items-center gap-2 rounded-md border border-text-3 px-3 py-2 text-sm font-semibold text-text hover:bg-surface-2" type="button" onClick={() => { setError(""); setAttempt((value) => value + 1); }}><RefreshCw aria-hidden="true" size={16} />重试</button> : null}</> : <><FilePlus2 aria-hidden="true" className="text-accent" size={24} /><p className="text-sm text-text-3" role="status">正在创建笔记...</p></>}
        {slow && !error ? <p role="status" className="text-xs leading-6 text-text-2">请求耗时较长，可以先到知识库查看；不会自动再创建一篇。</p> : null}
        <Link className="inline-flex min-h-10 items-center rounded-lg px-3 text-sm text-text-2 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={basePath}>{unknown || slow ? "检查知识库" : "返回知识库"}</Link>
      </div>
    </div>
  );
}
