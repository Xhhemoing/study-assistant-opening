import { useEffect, useState } from "react";
import type { TurnRecord, TutorMode } from "@aistudy/contracts";

/** After this long without a first token the learner sees that it is slower than usual. */
export const SLOW_TURN_MS = 3_000;
/** After this long without a first token the learner is offered 重试 / 取消. */
export const STALLED_TURN_MS = 90_000;

export type TurnWaitPhase = "normal" | "slow" | "stalled";

export function turnWaitPhase(elapsedMs: number): TurnWaitPhase {
  if (elapsedMs >= STALLED_TURN_MS) return "stalled";
  if (elapsedMs >= SLOW_TURN_MS) return "slow";
  return "normal";
}

export const TURN_WAIT_COPY = {
  slow: "正在准备回答，内容会逐步显示…",
  stalled: "等了比较久还没有开始回答。可以再试一次，或者先取消。",
  stalledEphemeral: "等了比较久还没有开始回答。取消后问题会留在输入框里，可以再发一次。",
} as const;

/**
 * Wall-clock wait for the first visible text of one turn. `waitKey` identifies the turn
 * (job id or client key); a new key restarts the clock. Inactive → always "normal".
 */
export function useTurnWaitPhase(active: boolean, waitKey: string | null): TurnWaitPhase {
  const [state, setState] = useState<{ key: string | null; phase: TurnWaitPhase }>({ key: null, phase: "normal" });
  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    const update = () => setState({ key: waitKey, phase: turnWaitPhase(Date.now() - startedAt) });
    const timers = [window.setTimeout(update, SLOW_TURN_MS), window.setTimeout(update, STALLED_TURN_MS)];
    // Background tabs throttle timers; re-check as soon as the tab is visible again.
    document.addEventListener("visibilitychange", update);
    return () => { timers.forEach(timer => window.clearTimeout(timer)); document.removeEventListener("visibilitychange", update); };
  }, [active, waitKey]);
  return active && state.key === waitKey ? state.phase : "normal";
}

export type FailedTurnRetry = { assistantTurnId: string; text: string; mode: TutorMode; clientKey: string };

/**
 * The newest saved turn ended without an answer (failed, including cancelled). Only that
 * pair can be retried. The client key is derived from the failed assistant turn, so
 * repeated clicks, reloads or a second tab replay the same retry on the server instead of
 * charging for a second one. outcome_unknown is never offered here (its cost is unsettled).
 */
export function failedTurnRetry(turns: readonly TurnRecord[]): FailedTurnRetry | null {
  const assistant = turns.at(-1);
  const user = turns.at(-2);
  if (assistant?.role !== "assistant" || assistant.status !== "failed" || user?.role !== "user" || !user.text.trim()) return null;
  if (assistant.systemQuery || user.systemQuery) return null;
  return { assistantTurnId: assistant.id, text: user.text, mode: user.mode, clientKey: `retry-${assistant.id}` };
}
