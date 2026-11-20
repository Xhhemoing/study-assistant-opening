"use client";

import { useCallback, useState } from "react";
import { TransitionLink } from "../v3/motion/view-transition";
import { buildPitfallPosterSvg, buildPosterFilename } from "./poster";
import { toDisplayShareCard, type ShareCardData } from "./schema";

export type PitfallShareCardProps = {
  card: ShareCardData;
  tryAvailable?: boolean;
};

export function PitfallShareCard({ card, tryAvailable = true }: PitfallShareCardProps) {
  const safeCard = toDisplayShareCard(card);
  const [downloadStatus, setDownloadStatus] = useState<"idle" | "saved" | "error">("idle");

  const handleDownloadPoster = useCallback(() => {
    try {
      const svg = buildPitfallPosterSvg(safeCard);
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = buildPosterFilename(safeCard);
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadStatus("saved");
    } catch {
      setDownloadStatus("error");
    }
  }, [safeCard]);

  const showCohortBadge = safeCard.cohortTrapRate !== null;
  const primaryHref = tryAvailable ? "/try" : "/login";
  const primaryLabel = tryAvailable ? "90 秒亲自排雷挑战" : "登录后开启完整诊断";

  return (
    <main className="min-h-screen bg-bg text-text">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-10 sm:px-6 sm:py-16">
        <header className="mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="font-serif text-title font-semibold tracking-tight text-text">
              AIstudy
            </span>
            <span className="text-meta text-text-3" aria-hidden="true">
              /
            </span>
            <span className="text-meta font-medium text-text-2">防踩坑避雷卡</span>
          </div>
          <span className="rounded-pill border border-line bg-surface px-3 py-1 text-meta font-medium text-text-2">
            {safeCard.subjectLabel}
          </span>
        </header>

        <article className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
          <div className="h-1.5 w-full bg-accent" aria-hidden="true" />

          <div className="space-y-6 p-6 sm:p-8">
            <div className="space-y-3">
              <h1
                data-page-title=""
                className="font-serif text-display font-semibold tracking-tight text-text sm:text-hero"
              >
                {safeCard.pitfallTitle}
              </h1>

              {showCohortBadge ? (
                <div
                  data-testid="cohort-trap-badge"
                  className="inline-flex flex-wrap items-center gap-1.5 rounded-pill border border-line bg-warn-soft px-3.5 py-1 text-meta font-medium text-warn"
                >
                  <span>
                    约 {safeCard.cohortTrapRate}% 同学曾在此踩坑 · {safeCard.cohortSampleSize} 人样本
                  </span>
                </div>
              ) : null}
            </div>

            <section
              aria-labelledby="pitfall-trap-heading"
              className="space-y-2 rounded-md border border-line bg-warn-soft/70 p-4 sm:p-5"
            >
              <h2
                id="pitfall-trap-heading"
                className="text-meta font-semibold tracking-wide text-warn"
              >
                容易踩的坑
              </h2>
              <p className="text-read leading-relaxed text-text">{safeCard.trapSummary}</p>
            </section>

            <section
              aria-labelledby="pitfall-rule-heading"
              className="space-y-2 rounded-md border border-line bg-accent-soft/75 p-4 sm:p-5"
            >
              <h2
                id="pitfall-rule-heading"
                className="text-meta font-semibold tracking-wide text-accent"
              >
                避坑口诀
              </h2>
              <p className="text-read font-medium leading-relaxed text-text">
                {safeCard.takeawayRule}
              </p>
            </section>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-2/60 px-6 py-4 sm:px-8">
            <div className="flex flex-wrap items-center gap-3">
              <TransitionLink
                href={primaryHref}
                className="inline-flex min-h-11 items-center justify-center rounded-md bg-ink px-5 py-2.5 text-ui-lg font-medium text-on-ink transition-opacity hover:opacity-90 focus-visible:outline-focus-ring"
              >
                {primaryLabel}
              </TransitionLink>

              <button
                type="button"
                onClick={handleDownloadPoster}
                className="inline-flex min-h-11 items-center justify-center rounded-md border border-line-strong bg-surface px-4 py-2.5 text-ui-lg font-medium text-text transition-colors hover:bg-surface-2 focus-visible:outline-focus-ring"
              >
                保存 SVG 海报
              </button>
            </div>

            <span className="text-meta text-text-3" role="status" aria-live="polite">
              {downloadStatus === "saved"
                ? "已生成 SVG 海报"
                : downloadStatus === "error"
                  ? "海报保存未完成，请重试"
                  : ""}
            </span>
          </footer>
        </article>

        <p className="mt-5 text-center text-meta text-text-3">
          这是一张匿名学习避雷卡，不含个人账号或成绩信息。
        </p>
      </div>
    </main>
  );
}

export type InvalidShareCardProps = {
  tryAvailable?: boolean;
};

export function InvalidShareCard({ tryAvailable = true }: InvalidShareCardProps) {
  const primaryHref = tryAvailable ? "/try" : "/login";
  const primaryLabel = tryAvailable ? "90 秒亲自排雷挑战" : "登录后开启完整诊断";
  const bodyCopy = tryAvailable
    ? "分享链接可能已过期，或复制时缺少了部分字符。你可以直接前往挑战页，亲自做一题热身。"
    : "分享链接可能已过期，或复制时缺少了部分字符。你可以直接登录进入完整学习空间。";

  return (
    <main className="min-h-screen bg-bg text-text">
      <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-12 sm:px-6">
        <article className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
          <div className="h-1.5 w-full bg-line-strong" aria-hidden="true" />
          <div className="space-y-4 p-6 sm:p-8">
            <p className="text-meta font-medium text-text-3">AIstudy · 防踩坑避雷卡</p>
            <h1
              data-page-title=""
              className="font-serif text-display font-semibold tracking-tight text-text"
            >
              这张避雷卡已失效或链接不完整
            </h1>
            <p className="text-read leading-relaxed text-text-2">{bodyCopy}</p>
            <div className="pt-2">
              <TransitionLink
                href={primaryHref}
                className="inline-flex min-h-11 items-center justify-center rounded-md bg-ink px-5 py-2.5 text-ui-lg font-medium text-on-ink transition-opacity hover:opacity-90 focus-visible:outline-focus-ring"
              >
                {primaryLabel}
              </TransitionLink>
            </div>
          </div>
        </article>
      </div>
    </main>
  );
}
