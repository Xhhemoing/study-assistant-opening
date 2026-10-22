"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { ui } from "../ui/controls";
import { successfulInteractionHaptic } from "../../design/haptics";
import { SuccessCheck, TextSwap, ThinkingLine } from "../motion/feedback";

/**
 * 评价结果的性质由批改服务给出（含帮助记录），前端只负责呈现，不从提示次数自行推断。
 * - correct_independent 独立答对；correct_assisted 借助帮助后答对（不宣布掌握）
 * - partial 部分正确；incorrect 答错；undetermined 无法判断（图片/题意/解法需核对）
 */
export type Verdict = "correct_independent" | "correct_assisted" | "partial" | "incorrect" | "undetermined";

/** 评价来源：自动批改、改评后的复核结果。改评不默认判正确。 */
export type VerdictSource = "auto" | "reviewed";

export type AttemptStage =
  | { kind: "draft"; attemptNo: number; draft: "empty" | "local" | "synced" | "failed" }
  | { kind: "submitting" }
  | { kind: "processing"; step: string }
  | { kind: "needs_recognition_check" }
  | { kind: "failed"; message: string }
  | { kind: "result"; verdict: Verdict; summary: string; source: VerdictSource }
  | { kind: "review_requested" };

type Handlers = {
  onExplainFirst: () => void;
  onHint: () => void;
  onSubmit: () => void;
  /** 提交失败后重新提交同一份答案（同一尝试，服务端幂等） */
  onRetrySubmit: () => void;
  onCheckRecognition: () => void;
  /** 新尝试：保留原提交与判定，新答案从空白或上一份答案开始 */
  onNewAttempt: (from: "blank" | "previous") => void;
  /** 借助帮助后答对：换一道不带提示的同类题 */
  onVariant: () => void;
  onExplain: () => void;
  onRequestReview: () => void;
  onNext: () => void;
};

type StageActionBarProps = Handlers & {
  stage: AttemptStage;
  hintsUsed: number;
  hintsTotal: number;
  nextLabel: string;
  /** 可靠结果后的次要动作（存为笔记 / 做成卡片），由业务按真实状态给出 */
  secondary?: ReactNode;
};

const DRAFT_LABEL = { empty: "", local: "草稿已存在本机", synced: "草稿已同步", failed: "草稿未能同步，本机仍保留" } as const;

/**
 * 阶段操作条：每个阶段只有一个主动作，主动作随结果性质变化。
 * 动效：阶段切换整组模糊上浮；处理中状态行流光 + 原地换字；独立答对时勾号进入 + 轻触觉
 * （仅在本次会话由处理中变为结果时播放，恢复页面不播放）。
 */
export function StageActionBar(props: StageActionBarProps) {
  const { stage, nextLabel } = props;
  const previous = useRef(stage.kind);
  const fresh = previous.current === "processing" && stage.kind === "result";
  useEffect(() => {
    if (fresh && stage.kind === "result" && stage.verdict === "correct_independent") successfulInteractionHaptic();
    previous.current = stage.kind;
  }, [stage, fresh]);

  const reviewButton = <button type="button" className={ui.quiet} onClick={props.onRequestReview}>申请改评</button>;

  return (
    <footer className="sticky bottom-0 z-10 shrink-0 px-2 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2 md:px-4">
      <div className="relative mx-auto max-w-[calc(var(--layout-wide)+16px)] overflow-hidden rounded-panel glass px-1.5 py-1">
      {(stage.kind === "processing" || stage.kind === "submitting") && (
        <div aria-hidden="true" className="absolute inset-x-6 top-0 h-px overflow-hidden">
          <span className="absolute inset-0 bg-linear-to-r from-transparent via-ai-1 to-transparent motion-safe:animate-shimmer" />
        </div>
      )}
      <div key={stage.kind === "result" ? `${stage.kind}-${stage.verdict}` : stage.kind} className="flex min-h-(--control-h) flex-wrap items-center gap-1 motion-safe:animate-text-in" aria-live="polite">
        {stage.kind === "draft" && <>
          <button type="button" className={ui.quiet} onClick={props.onExplainFirst}>我还不会，先讲一下</button>
          <button type="button" className={ui.quiet} onClick={props.onHint} disabled={props.hintsUsed >= props.hintsTotal}>
            提示{props.hintsUsed > 0 ? <TextSwap value={` ${props.hintsUsed}/${props.hintsTotal}`} /> : null}
          </button>
          <span className="flex-1 truncate px-2 text-right text-cap text-text-3">{stage.attemptNo > 1 ? `第 ${stage.attemptNo} 次作答 · ` : ""}<TextSwap value={DRAFT_LABEL[stage.draft]} /></span>
          <button type="button" className={ui.primary} onClick={props.onSubmit}>提交</button>
        </>}

        {stage.kind === "submitting" && <p className="px-3 text-ui"><ThinkingLine label="正在提交" /></p>}
        {stage.kind === "processing" && <p className="px-3 text-ui"><ThinkingLine label={stage.step} /></p>}

        {stage.kind === "needs_recognition_check" && <>
          <p className="flex-1 px-3 text-ui text-warn">识别结果需要你确认，不会按识别错误算你答错</p>
          <button type="button" className={ui.primary} onClick={props.onCheckRecognition}>核对识别内容</button>
        </>}

        {stage.kind === "failed" && <>
          <p role="alert" className="flex-1 px-3 text-ui text-danger">{stage.message}，答案和图片都还在</p>
          <button type="button" className={ui.primary} onClick={props.onRetrySubmit}>重新提交</button>
        </>}

        {stage.kind === "review_requested" && <>
          <p className="flex-1 px-3 text-ui text-text-2">改评已提交，复核前保留原结果</p>
          <button type="button" className={ui.primary} onClick={props.onNext}>{nextLabel}</button>
        </>}

        {stage.kind === "result" && <>
          <p className="flex min-w-0 flex-1 items-center gap-2 px-3 text-ui text-text">
            {stage.verdict === "correct_independent" || stage.verdict === "correct_assisted"
              ? <SuccessCheck play={fresh} label={stage.verdict === "correct_independent" ? "独立答对" : "提示后答对"} />
              : stage.verdict === "undetermined" ? <span role="img" aria-label="无法判断" className="text-warn">?</span>
              : <span role="img" aria-label={stage.verdict === "partial" ? "部分正确" : "答错"} className={stage.verdict === "partial" ? "text-warn" : "text-danger"}>{stage.verdict === "partial" ? "◐" : "✕"}</span>}
            <span className="min-w-0">{stage.summary}{stage.source === "reviewed" ? <span className="ml-2 text-cap text-text-2">复核后</span> : null}</span>
          </p>
          {props.secondary}
          {stage.verdict === "correct_independent" && <>{reviewButton}<button type="button" className={ui.primary} onClick={props.onNext}>{nextLabel}</button></>}
          {stage.verdict === "correct_assisted" && <><button type="button" className={ui.quiet} onClick={props.onNext}>{nextLabel}</button><button type="button" className={ui.primary} onClick={props.onVariant}>不看提示再做一道</button></>}
          {stage.verdict === "partial" && <>{reviewButton}<button type="button" className={ui.primary} onClick={() => props.onNewAttempt("previous")}>修改这一处</button></>}
          {stage.verdict === "incorrect" && <>{reviewButton}<button type="button" className={ui.quiet} onClick={props.onExplain}>看讲解</button><button type="button" className={ui.primary} onClick={() => props.onNewAttempt("blank")}>再试一次</button></>}
          {stage.verdict === "undetermined" && <><button type="button" className={ui.quiet} onClick={props.onExplain}>说明我的解法</button><button type="button" className={ui.primary} onClick={props.onCheckRecognition}>核对内容</button></>}
        </>}
      </div>
      </div>
    </footer>
  );
}
