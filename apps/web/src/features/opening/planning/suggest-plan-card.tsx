"use client";

import type { PlanDraft, PlannedBlock, TaskItem, TimeBlock } from "@aistudy/contracts";
import { useMemo, useState } from "react";
import { OpeningApiError, type OpeningApi } from "../client/api";
import { buttonClass, secondaryButtonClass } from "../design/ui";
import { canAcceptPlan } from "./plan-action";

function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function resolveTodayTimeZone(timeZone?: string): string {
  if (timeZone && timeZone.trim()) return timeZone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

export type SuggestPreset = "timetable" | "tonight" | "one_hour";

export const SUGGEST_PRESET_LABELS: Record<SuggestPreset, string> = {
  timetable: "课表空档（默认）",
  tonight: "今晚 19:00–22:00",
  one_hour: "只排 1 小时",
};

export type PlanDiff = {
  added: PlannedBlock[];
  moved: PlannedBlock[];
  removed: PlannedBlock[];
  unscheduledTaskIds: string[];
};

/** Compare draft vs currently confirmed plan. Propose never mutates confirmed. */
export function diffAgainstConfirmedPlan(
  confirmed: readonly PlannedBlock[],
  draft: Pick<PlanDraft, "blocks" | "unscheduledTaskIds">,
): PlanDiff {
  const confirmedByTask = new Map(confirmed.map((block) => [block.taskId, block]));
  const draftByTask = new Map(draft.blocks.map((block) => [block.taskId, block]));
  const added: PlannedBlock[] = [];
  const moved: PlannedBlock[] = [];
  for (const block of draft.blocks) {
    const previous = confirmedByTask.get(block.taskId);
    if (!previous) {
      added.push(block);
      continue;
    }
    if (previous.start !== block.start || previous.end !== block.end) {
      moved.push(block);
    }
  }
  const removed = confirmed.filter((block) => !draftByTask.has(block.taskId));
  return {
    added,
    moved,
    removed,
    unscheduledTaskIds: [...draft.unscheduledTaskIds],
  };
}

function localClockIso(date: string, hhmm: string): string {
  const value = new Date(`${date}T${hhmm}:00`);
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`无效的本地时间：${date} ${hhmm}`);
  }
  return value.toISOString();
}

/**
 * Build propose body. Default preset omits `free` so the server derives from
 * timetable + planning settings. Explicit presets pass free-kind blocks only.
 */
export function buildSuggestProposeBody(
  preset: SuggestPreset,
  date: string,
  clientKey: string,
): { date: string; clientKey: string; free?: TimeBlock[] } {
  if (preset === "timetable") {
    return { date, clientKey };
  }
  if (preset === "tonight") {
    return {
      date,
      clientKey,
      free: [{
        start: localClockIso(date, "19:00"),
        end: localClockIso(date, "22:00"),
        kind: "free",
      }],
    };
  }
  return {
    date,
    clientKey,
    free: [{
      start: localClockIso(date, "19:00"),
      end: localClockIso(date, "20:00"),
      kind: "free",
    }],
  };
}

export type SuggestPlanControllers = {
  propose: (preset: SuggestPreset) => Promise<PlanDraft>;
  /** Explicit confirm only — never called from propose. */
  accept: (draft: PlanDraft) => Promise<PlanDraft>;
  reject: (draftId: string) => Promise<PlanDraft>;
};

/**
 * Factory for propose → review → accept. Accept is a separate call so UI tests
 * can assert propose alone does not change the confirmed plan.
 */
export function createSuggestPlanControllers(
  api: Pick<OpeningApi, "proposePlan" | "acceptPlan" | "rejectPlan">,
  options: { date: string; mintClientKey?: () => string } ,
): SuggestPlanControllers {
  const mint = options.mintClientKey ?? (() => (
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `suggest-plan-${crypto.randomUUID()}`
      : `suggest-plan-${Date.now()}`
  ));
  return {
    async propose(preset) {
      const body = buildSuggestProposeBody(preset, options.date, mint());
      return api.proposePlan(body);
    },
    async accept(draft) {
      return api.acceptPlan({
        draftId: draft.id,
        expectedBaseVersion: draft.baseVersion,
        clientKey: mint(),
      });
    },
    async reject(draftId) {
      return api.rejectPlan(draftId);
    },
  };
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function taskTitle(tasks: readonly TaskItem[], taskId: string): string {
  return tasks.find((task) => task.id === taskId)?.title ?? "学习任务";
}

export function SuggestPlanCard({
  api,
  date = localDateKey(),
  acceptedVersion = 0,
  confirmedBlocks = [],
  tasks = [],
  onChanged,
}: {
  api: Pick<OpeningApi, "proposePlan" | "acceptPlan" | "rejectPlan">;
  date?: string;
  acceptedVersion?: number;
  confirmedBlocks?: readonly PlannedBlock[];
  tasks?: readonly TaskItem[];
  onChanged?: () => void;
}) {
  const timeZone = resolveTodayTimeZone();
  const controllers = useMemo(
    () => createSuggestPlanControllers(api, { date }),
    [api, date],
  );
  const [preset, setPreset] = useState<SuggestPreset>("timetable");
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const diff = draft ? diffAgainstConfirmedPlan(confirmedBlocks, draft) : null;
  const stale = Boolean(draft && draft.baseVersion !== acceptedVersion);

  async function onPropose() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      setDraft(await controllers.propose(preset));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "建议计划生成失败");
    } finally {
      setPending(false);
    }
  }

  async function onConfirm() {
    if (!draft || !canAcceptPlan({ pending, stale })) return;
    setPending(true);
    setError("");
    try {
      await controllers.accept(draft);
      setDraft(null);
      onChanged?.();
    } catch (reason) {
      setError(
        reason instanceof OpeningApiError && reason.status === 409
          ? "计划已变化，请重新生成后再确认；没有重复提交。"
          : reason instanceof Error ? reason.message : "确认建议计划失败",
      );
    } finally {
      setPending(false);
    }
  }

  async function onReject() {
    if (!draft || pending) return;
    setPending(true);
    setError("");
    try {
      await controllers.reject(draft.id);
      setDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "取消草案失败，请重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3 border-b border-zinc-200 bg-white px-4 py-4" aria-labelledby="suggest-plan-heading">
      <div>
        <h3 className="text-xs font-semibold text-zinc-800" id="suggest-plan-heading">按建议安排</h3>
        <p className="mt-1 text-[11px] leading-5 text-zinc-500">
          一键生成草案并预览差异；确认后才改变正式计划（时区 {timeZone}）。
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="排程预设">
        {(Object.keys(SUGGEST_PRESET_LABELS) as SuggestPreset[]).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={preset === value}
            disabled={pending || Boolean(draft)}
            className={`${secondaryButtonClass} ${preset === value ? "border-emerald-600 bg-emerald-50 text-emerald-900" : ""}`}
            onClick={() => setPreset(value)}
          >
            {SUGGEST_PRESET_LABELS[value]}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`${buttonClass} w-full`}
        disabled={pending || Boolean(draft)}
        onClick={() => void onPropose()}
      >
        {pending && !draft ? "正在生成建议…" : "生成建议计划"}
      </button>
      {error ? <p className="text-xs leading-5 text-red-700" role="alert">{error}</p> : null}
      {draft && diff ? (
        <div className="space-y-3 border-t border-zinc-200 pt-3">
          <p className="text-xs font-semibold text-zinc-900">与已确认计划的差异</p>
          <p className="text-xs leading-5 text-zinc-600">
            新增 {diff.added.length} · 移动 {diff.moved.length} · 移出 {diff.removed.length} · 未安排 {diff.unscheduledTaskIds.length}
          </p>
          {diff.added.length ? (
            <ul className="space-y-1 text-xs text-zinc-600" aria-label="新增安排">
              {diff.added.map((block) => (
                <li key={`add-${block.taskId}-${block.start}`}>
                  新增：{taskTitle(tasks, block.taskId)} · {timeLabel(block.start)}–{timeLabel(block.end)}
                </li>
              ))}
            </ul>
          ) : null}
          {diff.moved.length ? (
            <ul className="space-y-1 text-xs text-zinc-600" aria-label="移动安排">
              {diff.moved.map((block) => (
                <li key={`move-${block.taskId}-${block.start}`}>
                  移动：{taskTitle(tasks, block.taskId)} · {timeLabel(block.start)}–{timeLabel(block.end)}
                </li>
              ))}
            </ul>
          ) : null}
          {diff.unscheduledTaskIds.length ? (
            <p className="text-xs text-amber-800">未安排 {diff.unscheduledTaskIds.length} 项，确认后仍保持未排入。</p>
          ) : null}
          {stale ? (
            <p className="text-xs leading-5 text-amber-800">计划版本已变化。请取消旧草案，重新生成后再确认。</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={!canAcceptPlan({ pending, stale })}
              onClick={() => void onConfirm()}
            >
              确认建议
            </button>
            <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => void onReject()}>
              取消草案
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
