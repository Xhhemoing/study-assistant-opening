"use client";

import { useEffect, useState } from "react";
import type { CourseGoal, TaskItem, TeachingActivity } from "@aistudy/contracts";
import { resolveWorkspaceTimeZone } from "@aistudy/domain";
import type { OpeningApi } from "../opening/client/api";

export function useCourseStudy(courseId: string, api: OpeningApi, enabled: boolean, loadGoal = Boolean(courseId)) {
  const [activities, setActivities] = useState<TeachingActivity[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [goal, setGoal] = useState<CourseGoal | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const [taskError, setTaskError] = useState("");
  const [revision, setRevision] = useState(0);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setActivities([]); setTasks([]); setGoal(null); setError(""); setTaskError(""); setLoading(enabled); setTimeZone(null);
    if (enabled) {
      void api.listTeachingActivities().then(rows => { if (active) setActivities(rows); })
        .catch(() => { if (active) setError("学习活动暂时无法读取，请重试；仍可阅读材料或独立练习。"); })
        .finally(() => { if (active) setLoading(false); });
      void api.listTasks().then(result => { if (active) setTasks(result.tasks); })
        .catch(() => { if (active) setTaskError("待办任务暂时无法读取，可继续已有活动或自由练习。"); });
    }
    if (loadGoal && courseId) {
      void api.getPlanningSettings().then(result => {
        if (result.invalidStoredSettings) throw new Error("stored time zone unavailable");
        if (active) setTimeZone(resolveWorkspaceTimeZone(result.settings?.timeZone));
      }).catch(() => { if (active) setTaskError("学习时区暂时无法读取，请重试。"); });
      void api.getAdaptivePrefs().then(result => {
        if (result.invalidStoredPrefs) throw new Error("stored goal preferences unavailable");
        if (active) setGoal(result.prefs.courseGoals[courseId] ?? null);
      })
        .catch(() => { if (active) setTaskError("目标摘要暂时无法读取，可直接练习或在课程目标中重试。"); });
    }
    return () => { active = false; };
  }, [loadGoal, api, courseId, enabled, revision]);
  return { activities, tasks, goal, timeZone, loading, error, taskError, reload: () => setRevision(value => value + 1) };
}
