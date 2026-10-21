"use client";

import { useEffect, useMemo, useState } from "react";
import type { LearningAttempt } from "@aistudy/contracts";
import { createOpeningLearningClient } from "../client/learning-client";
import { LoadError, LoadingRows } from "../design/ui";
import { materialAnalysisEntry } from "../library/material-analysis-link";
import { AssistantView } from "./assistant-view";
import type { AssistantEntry } from "./assistant-entry";

export function AssistantSession({ entry }: { entry: AssistantEntry & { learningAttempt?: LearningAttempt } }) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const [verified, setVerified] = useState(Boolean(entry.learningAttempt));
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const attemptId = entry.context?.attemptId;
  useEffect(() => {
    if (!attemptId || entry.learningAttempt || entry.error) return;
    let active = true;
    setError("");
    void client.getAttempt(attemptId).then(value => {
      if (!active) return;
      if (value.attemptId !== attemptId) {
        setError("本次作答的身份或版本不一致，请返回原题重新打开。"); return;
      }
      setVerified(true);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "无法读取本次作答，请重试。"); });
    return () => { active = false; };
  }, [attemptId, client, entry, revision]);
  if (attemptId && !verified && !entry.error) return <div className="p-4">{error ? <LoadError message={error} onRetry={() => setRevision(value => value + 1)} /> : <LoadingRows label="正在准备本题提问…" />}</div>;
  return <AssistantView embedded learningAttempt={entry.learningAttempt} initialConversationId={entry.conversation} initialCourseId={entry.context?.courseId ?? null} {...(entry.context?.sourceId ? materialAnalysisEntry(entry.context.sourceId, entry.context.page === undefined ? undefined : String(entry.context.page)) : {})} startFresh={entry.fresh} studyContext={entry.context} studyContextError={entry.error} />;
}
