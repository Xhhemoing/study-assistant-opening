"use client";

import { FilePlus2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createEditorApi } from "./editor-api";
import { createEmptyLocalDraft } from "./local-draft";

export function NewDocument() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const draft = createEmptyLocalDraft();
    createEditorApi().createDocument({
      title: draft.title,
      blocks: draft.blocks.map(({ id, type, content }) => ({
        id,
        type,
        content: { blockNoteContent: content, props: null, children: [] },
      })),
    }).then((document) => {
      if (active) router.replace(`/library/${document.id}`);
    }).catch(() => {
      if (active) setError("暂时无法创建笔记，请稍后重试。");
    });
    return () => { active = false; };
  }, [attempt, router]);

  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6 py-12">
      <div className="grid max-w-sm justify-items-center gap-4 text-center">
        {error ? <><FilePlus2 aria-hidden="true" className="text-danger" size={24} /><p className="text-sm text-danger" role="alert">{error}</p><button className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm font-semibold text-text hover:bg-surface-2" type="button" onClick={() => { setError(""); setAttempt((value) => value + 1); }}><RefreshCw aria-hidden="true" size={16} />重试</button></> : <><FilePlus2 aria-hidden="true" className="text-primary" size={24} /><p className="text-sm text-text-dim" role="status">正在创建笔记...</p></>}
      </div>
    </main>
  );
}
