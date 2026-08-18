import type { SubmissionIssue } from "./practice-player-model";

export function formatDuration(value: number): string {
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function getIssueMessage(issue: SubmissionIssue | null): string {
  if (issue === "answer-required") return "请先完成作答。";
  if (issue === "verdict-required") return "请先检查答案。";
  return "";
}

export function PlayerSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8" aria-busy="true">
      <div className="h-5 w-28 animate-pulse rounded bg-surface-2" />
      <div className="space-y-3 border-b border-line pb-6">
        <div className="h-8 w-3/4 animate-pulse rounded bg-surface-2" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-surface-2" />
      </div>
      <div className="h-48 animate-pulse rounded-lg bg-surface-2" />
    </div>
  );
}
