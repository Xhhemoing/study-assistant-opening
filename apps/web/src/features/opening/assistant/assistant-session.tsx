"use client";

import { useEffect, useMemo, useState } from "react";
import type { LearningAttempt } from "@aistudy/contracts";
import { createOpeningLearningClient } from "../client/learning-client";
import { LoadError, LoadingRows } from "../design/ui";
import { materialAnalysisEntry } from "../library/material-analysis-link";
import { AssistantView } from "./assistant-view";
import { ConversationSurface } from "./conversation-companion";
import type { AssistantEntry } from "./assistant-entry";
import type { StudyConversationContext } from "./study-conversation-context";
import { userFacingMessage } from "../../../lib/user-facing-error";

const contextFields = ["courseId", "activityId", "blockId", "contentVersion", "attemptId", "itemVersionId", "kcMappingVersion", "sourceId", "sourceVersion", "page", "chunkId"] as const;
const mismatchMessage = "本次提问与原题的作答记录不一致，请返回原题重新打开。";

function boundAttemptContext(selected: StudyConversationContext | undefined, attempt: LearningAttempt): StudyConversationContext {
  const canonical = { ...attempt.contextAnchor, courseId: attempt.courseId, attemptId: attempt.id, itemVersionId: attempt.itemVersionId };
  for (const key of contextFields) {
    if (selected?.[key] !== undefined && selected[key] !== canonical[key]) throw new Error(mismatchMessage);
  }
  const bound = Object.fromEntries(contextFields.flatMap(key => canonical[key] == null ? [] : [[key, canonical[key]]]));
  return { ...selected, ...bound, purpose: selected?.purpose ?? "learning_help" };
}

export function AssistantSession({ entry, embedded = true, implicitResumeVersion }: { entry: AssistantEntry & { learningAttempt?: LearningAttempt }; embedded?: boolean; implicitResumeVersion?: number }) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const [restored, setRestored] = useState<{ selectionKey: string; attempt: LearningAttempt } | null>(null);
  const [error, setError] = useState<{ selectionKey: string; message: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const attemptId = entry.context?.attemptId;
  const selectionKey = JSON.stringify(entry.context ?? null);
  useEffect(() => {
    if (!attemptId || entry.learningAttempt || entry.error) return;
    let active = true;
    setRestored(null);
    setError(null);
    void client.getAttemptContext(attemptId).then(value => {
      if (!active) return;
      if (value.attempt.id !== attemptId) { setError({ selectionKey, message: mismatchMessage }); return; }
      setRestored({ selectionKey, attempt: value.attempt });
    }).catch(reason => { if (active) setError({ selectionKey, message: userFacingMessage(reason, "无法读取本次作答，请重试。") }); });
    return () => { active = false; };
  }, [attemptId, client, entry.error, entry.learningAttempt, selectionKey, revision]);

  const attempt = entry.learningAttempt ?? (restored?.selectionKey === selectionKey ? restored.attempt : undefined);
  let context = entry.context;
  let contextError = error?.selectionKey === selectionKey ? error.message : "";
  if (attempt) {
    try { context = boundAttemptContext(entry.context, attempt); }
    catch { contextError = mismatchMessage; }
  }
  if ((attemptId || attempt) && (entry.error || !attempt || contextError)) return <div className="p-4">{entry.error || contextError ? <LoadError message={entry.error || contextError} onRetry={() => setRevision(value => value + 1)} /> : <LoadingRows label="正在准备本题提问…" />}</div>;
  if (!embedded && !attempt && !context && !entry.error) return <ConversationSurface initialConversationId={entry.conversation} startFresh={entry.fresh} />;
  return <AssistantView embedded={embedded} learningAttempt={attempt} initialConversationId={entry.conversation} implicitResumeVersion={implicitResumeVersion} initialCourseId={context?.courseId ?? null} {...(context?.sourceId ? materialAnalysisEntry(context.sourceId, context.page === undefined ? undefined : String(context.page)) : {})} startFresh={entry.fresh} studyContext={context} studyContextError={entry.error} />;
}
