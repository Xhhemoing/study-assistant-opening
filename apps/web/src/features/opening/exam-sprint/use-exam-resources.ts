"use client";

import { openingAdaptivePrefsSchema, sourceRecordSchema, type CourseGoal, type SourceRecord } from "@aistudy/contracts";
import { useEffect, useState } from "react";
import { z } from "zod";

export type ExamResources = { courses: Array<{ id: string; title: string }>; sources: SourceRecord[]; goals: Record<string, CourseGoal> };
const coursesSchema = z.object({ courses: z.array(z.object({ id: z.string(), title: z.string() })) });
const prefsSchema = z.object({ prefs: openingAdaptivePrefsSchema });
const sourcesSchema = z.array(sourceRecordSchema);

async function read(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`读取课程或资料失败（${response.status}），请重试。`);
  return response.json();
}

export function useExamResources(enabled: boolean) {
  const [resources, setResources] = useState<ExamResources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true); setError(null);
    Promise.all([read("/api/courses", controller.signal), read("/api/opening/sources", controller.signal), read("/api/opening/adaptive-planning", controller.signal)])
      .then(([courses, sources, prefs]) => {
        const next = { courses: coursesSchema.parse(courses).courses, sources: sourcesSchema.parse(sources).filter(source => source.uploadState === "uploaded"), goals: prefsSchema.parse(prefs).prefs.courseGoals };
        if (!controller.signal.aborted) setResources(next);
      }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "课程与资料读取失败。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, revision]);
  return { resources, loading, error, reload: () => setRevision(value => value + 1) };
}
