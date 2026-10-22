"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { ui } from "@aistudy/ui";
import { successfulInteractionHaptic } from "../../design/haptics";

/**
 * 作答阶段。由现有作答/批改响应映射而来，前端不自行推断：
 * 不从提示次数判断「独立完成」，不写死复测天数。
 */
export type AttemptStage =
  | { kind: "draft" }
  | { kind: "processing" }
  | { kind: "needs_recognition_check" }
  | { kind: "needs_grading_check" }
  | { kind: "failed"; message: string }
  | { kind: "result"; correct: boolean; summary: string; nextLabel: string }
  | { kind: "corrected"; summary: string; nextLabel: string };

type StageActionBarProps = {
  stage: AttemptStage;
  hintsUsed: number;
  hintsTotal: number;
  onExplainFirst: () => void;
  onHint: () => void;
  onSubmit: () => void;
  onRetry: () => void;
  onCheckRecognition: () => void;
  onDisputeGrading: () => void;
  onReviseStep: () => void;
  onNext: () => void;
  /** 可靠结果后才出现的次要动作，由业务按真实状态给出 */
  secondary?: ReactNode;
};

/**
 * 每个阶段只有一个主动作。动效：阶段切换时整组内容上浮淡入（key=阶段）；
 * 处理中顶部 AI 渐变流光；答对时勾号描边 + 轻触觉，仅在本次会话内由处理中变为结果时播放，恢复时不播放。
 */
export function StageActionBar(props: StageActionBarProps) {
  const { stage } = props;
  const previous = useRef(stage.kind);
  const celebrate = previous.current === "processing" && stage.kind === "result" && stage.correct;
  useEffect(() => {
    if (celebrate) successfulInteractionHaptic();
    previous.current = stage.kind;
  }, [stage.kind, celebrate]);

  return (
    <footer className="relative shrink-0 border-t border-line bg-surface px-3 py-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] md:px-6">
      {stage.kind === "processing" && (
        <div aria-hidden="true" className="absolute inset-x-0 -top-px h-0.5 overflow-hidden">
          <span className="absolute inset-0 bg-linear-to-r from-transparent via-ai-1 to-transparent motion-safe:animate-shimmer" />
        </div>
      )}
      <div key={stage.kind} className="flex min-h-11 flex-wrap items-center gap-1 motion-safe:animate-enter" aria-live="polite">
        {stage.kind === "draft" && <>
          <button type="button" className={ui.quiet} onClick={props.onExplainFirst}>我还不会，先讲一下</button>
          <button type="button" className={ui.quiet} onClick={props.onHint} disabled={props.hintsUsed >= props.hintsTotal}>
            提示{props.hintsUsed > 0 ? ` ${props.hintsUsed}/${props.hintsTotal}` : ""}
          </button>
          <span className="flex-1" />
          <button type="button" className={ui.primary} onClick={props.onSubmit}>提交</button>
        </>}

        {stage.kind === "processing" && <p className="px-3 text-[15px] text-text-2 motion-safe:animate-breathe">正在批改，你的答案已保存</p>}

        {stage.kind === "needs_recognition_check" && <>
          <p className="flex-1 px-3 text-[15px] text-warn">识别结果需要你确认</p>
          <button type="button" className={ui.primary} onClick={props.onCheckRecognition}>检查识别内容</button>
        </>}

        {stage.kind === "needs_grading_check" && <>
          <p className="flex-1 px-3 text-[15px] text-warn">这次结果不确定，需要确认</p>
          <button type="button" className={ui.quiet} onClick={props.onDisputeGrading}>我来说明</button>
          <button type="button" className={ui.primary} onClick={props.onReviseStep}>修改这一步</button>
        </>}

        {stage.kind === "failed" && <>
          <p role="alert" className="flex-1 px-3 text-[15px] text-danger">{stage.message}，答案和图片都还在</p>
          <button type="button" className={ui.primary} onClick={props.onRetry}>重试</button>
        </>}

        {(stage.kind === "result" || stage.kind === "corrected") && <>
          <p className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[15px] text-text">
            {stage.kind === "result" && (stage.correct
              ? <svg viewBox="0 0 16 16" width="16" height="16" aria-label="正确" role="img" className="shrink-0 text-accent"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="24" className={celebrate ? "motion-safe:animate-draw" : ""} /></svg>
              : <span aria-label="错误" role="img" className="text-danger">✕</span>)}
            <span className="min-w-0">{stage.summary}</span>
          </p>
          {props.secondary}
          {stage.kind === "result" && !stage.correct && <button type="button" className={ui.quiet} onClick={props.onDisputeGrading}>判错了</button>}
          <button type="button" className={ui.primary} onClick={props.onNext}>{stage.nextLabel}</button>
        </>}
      </div>
    </footer>
  );
}
