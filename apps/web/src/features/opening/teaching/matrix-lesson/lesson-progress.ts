"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";

const assistanceSchema = z.enum(["independent", "hinted", "revealed"]);
const progressSchema = z.object({
  section: z.number().int().min(0).max(4), draftAnswer: z.string().max(4000),
  hintSeen: z.boolean(), solutionSeen: z.boolean(), assistance: assistanceSchema,
  original: z.object({ answer: z.string().min(1).max(4000), assistance: assistanceSchema }).strict().nullable(),
  reflection: z.enum(["same_reasoning", "calculation_gap", "need_explanation"]).nullable(),
}).strict().refine(value => Boolean(value.original) === value.solutionSeen && (value.section <= 2 || value.original !== null) && (!value.reflection || value.original !== null));
export type MatrixLessonProgress = z.infer<typeof progressSchema>;
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const memory = new Map<string, MatrixLessonProgress>();
let storageUnavailable = false;
export const initialMatrixLessonProgress = (): MatrixLessonProgress => ({ section: 0, draftAnswer: "", hintSeen: false, solutionSeen: false, assistance: "independent", original: null, reflection: null });

/** Original thinking is frozen before revealing this question's explanation. This is a note, not evidence. */
export function recordMatrixLessonOriginal(progress: MatrixLessonProgress, skip = false): MatrixLessonProgress {
  if (progress.original) return { ...progress, section: 3 };
  const answer = skip && !progress.draftAnswer.trim() ? "暂时不会，先看讲解" : progress.draftAnswer;
  if (!answer.trim()) return progress;
  const assistance = skip || progress.assistance === "revealed" ? "revealed" : progress.hintSeen || progress.assistance === "hinted" ? "hinted" : "independent";
  return { ...progress, original: { answer, assistance }, solutionSeen: true, section: 3 };
}
export function visitMatrixLessonSection(progress: MatrixLessonProgress, section: number): MatrixLessonProgress {
  const next = Math.max(0, Math.min(4, Math.trunc(section)));
  return { ...progress, section: next > 2 && !progress.original ? 2 : next };
}
export function revealMatrixLessonHint(progress: MatrixLessonProgress): MatrixLessonProgress {
  return { ...progress, hintSeen: true, assistance: progress.assistance === "revealed" ? "revealed" : "hinted" };
}

export function readMatrixLessonProgress(courseId: string, storage: StorageLike | null): MatrixLessonProgress {
  const key = `study:matrix-concept:v1:${courseId}`;
  if (!storageUnavailable && storage) {
    let raw: string | null = null;
    try { raw = storage.getItem(key); } catch { storageUnavailable = true; }
    if (raw !== null) {
      try {
        const envelope = z.object({ courseId: z.literal(courseId), version: z.literal(1), progress: progressSchema }).strict().safeParse(JSON.parse(raw));
        if (envelope.success) { memory.set(key, envelope.data.progress); return envelope.data.progress; }
      } catch { /* A malformed note is never applied as a valid lesson state. */ }
      return initialMatrixLessonProgress();
    }
  }
  return memory.get(key) ?? initialMatrixLessonProgress();
}
export function saveMatrixLessonProgress(courseId: string, progress: MatrixLessonProgress, storage: StorageLike | null): boolean {
  const key = `study:matrix-concept:v1:${courseId}`;
  memory.set(key, progress);
  if (!storageUnavailable && storage) {
    try { storage.setItem(key, JSON.stringify({ courseId, version: 1, progress })); return true; }
    catch { storageUnavailable = true; }
  }
  return false;
}
export function useMatrixLessonProgress(courseId: string) {
  const [progress, setProgress] = useState(initialMatrixLessonProgress);
  const current = useRef(progress);
  const storage = useRef<StorageLike | null>(null);
  const [ready, setReady] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  useEffect(() => {
    try { storage.current = window.sessionStorage; } catch { storageUnavailable = true; }
    const restored = readMatrixLessonProgress(courseId, storage.current);
    current.current = restored; setProgress(restored); setReady(true);
    setStorageWarning(storageUnavailable || !storage.current);
  }, [courseId]);
  function update(change: (value: MatrixLessonProgress) => MatrixLessonProgress) {
    if (!ready) return;
    const next = change(current.current);
    current.current = next; setProgress(next);
    setStorageWarning(!saveMatrixLessonProgress(courseId, next, storage.current));
  }
  return { progress, update, ready, storageWarning };
}
