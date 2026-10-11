/**
 * V2-16 Experience — honest empty when UI teaching-loop trial gate is closed.
 * Must not silently fall into free chat as if the teaching loop were on.
 */

"use client";

import Link from "next/link";
import { ui } from "../design/ui";

export function TeachingLoopTrialEmpty({
  assistantHref,
  loopEnabled,
  workspaceEnabled,
}: {
  assistantHref?: string | null;
  /** Optional explicit flag states for honesty copy / tests. */
  loopEnabled?: boolean;
  workspaceEnabled?: boolean;
}) {
  const loopOn = loopEnabled ?? false;
  const workspaceOn = workspaceEnabled ?? false;
  const missing: string[] = [];
  if (!loopOn) missing.push("OPENING_TEACHING_LOOP");
  if (!workspaceOn) missing.push("OPENING_TEACHING_WORKSPACE");

  return (
    <section
      className="flex h-full min-h-0 flex-col items-center justify-center px-5 py-10 text-center"
      aria-labelledby="teaching-loop-trial-empty-heading"
      data-teaching-loop-trial-empty="true"
      data-loop-enabled={loopOn ? "true" : "false"}
      data-workspace-enabled={workspaceOn ? "true" : "false"}
    >
      <h2
        id="teaching-loop-trial-empty-heading"
        className="text-[15px] font-semibold text-zinc-900"
      >
        AI 主讲试运行未开启
      </h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-zinc-500">
        进入主讲工作台（TeachingWorkspace）需要同时开启{" "}
        <span className="font-medium text-zinc-700">OPENING_TEACHING_LOOP</span>{" "}
        与{" "}
        <span className="font-medium text-zinc-700">OPENING_TEACHING_WORKSPACE</span>
        。当前未同时开启
        {missing.length > 0 ? (
          <>
            （缺少：
            <span className="font-medium text-zinc-700">{missing.join("、")}</span>
            ）
          </>
        ) : null}
        ，因此不会进入主讲工作台，也不会把自由对话当成主讲试运行。
      </p>
      <p className="mt-4 rounded-lg bg-zinc-50 px-3 py-2 text-[11px] leading-5 text-zinc-600 ring-1 ring-zinc-900/5">
        试运行关闭时保留既有活动与断点内容；不会伪造讲义或假装主讲已可用。
      </p>
      <p className="mt-4">
        <Link href={assistantHref ?? "/opening/assistant"} className={ui.quiet}>
          打开自由对话（次要）
        </Link>
      </p>
    </section>
  );
}
