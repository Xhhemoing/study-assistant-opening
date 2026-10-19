"use client";

import { useState } from "react";
import type { TeachingToolsContext } from "../opening/teaching/teaching-workspace";
import { StudyContextTools } from "../opening/teaching/study-context-tools";
import { studyConversationIdentity } from "../opening/assistant/study-conversation-context";
import { ui } from "../opening/design/ui";

export function CourseStudyContextTools({ context }: { context: TeachingToolsContext }) {
  const [selected, setSelected] = useState(context.sourceRefs.length === 1 ? 0 : -1);
  const ref = context.sourceRefs[selected];
  const version = ref && (typeof ref.version === "number" || (typeof ref.version === "string" && /^\d+$/.test(ref.version))) ? Number(ref.version) : undefined;
  const pinned = version !== undefined && Number.isSafeInteger(version) && version >= 0;
  const questionBound = context.isQuestion && Boolean(context.learningAttempt);
  const blocked = questionBound ? undefined : context.sourceRefs.length && !ref ? "请先选定本次提问使用的原材料。历史引用仍保留各自版本。"
    : ref && !pinned ? "这条讲解引用缺少可锁定的材料版本。请从引用入口打开原文，再按明确版本提问；笔记仍可保存。"
      : !context.sourceRefs.length && context.activity.sourceIds.length ? "本讲解没有可锁定的资料版本。请打开原材料后提问，避免将旧讲解静默配给新版资料。" : undefined;
  const studyContext = { courseId: context.activity.courseId ?? undefined, activityId: context.activity.id,
    blockId: context.blockId ?? undefined, contentVersion: context.contentVersion,
    attemptId: context.learningAttempt?.id, itemVersionId: context.learningAttempt?.itemVersionId ?? undefined, purpose: "learning_help" as const,
    label: context.unitTitle, fragment: context.unitText,
    ...(!questionBound && ref && pinned ? { sourceId: ref.sourceId, sourceVersion: version, page: ref.page ?? undefined } : {}),
  };
  return <div className="space-y-4">
    {context.sourceRefs.length > 1 && !questionBound ? <label className="block space-y-1 text-xs text-zinc-700"><span>本次提问的材料</span><select className={ui.input} value={selected} onChange={event => setSelected(Number(event.target.value))}><option value={-1}>选择一份固定版本原文</option>{context.sourceRefs.map((source, index) => <option key={index} value={index}>{context.sourceNameById?.[source.sourceId] || `引用材料 ${index + 1}`}{source.page ? ` · 第 ${source.page} 页` : ""}{source.version != null ? ` · v${source.version}` : " · 版本待核对"}</option>)}</select></label> : null}
    <StudyContextTools key={studyConversationIdentity(studyContext)} context={studyContext} isQuestion={context.isQuestion}
      learningAttempt={context.learningAttempt} questionBlockedReason={blocked} />
  </div>;
}
