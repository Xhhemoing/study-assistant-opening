"use client";

/**
 * V2-15 Experience — operable matrix_transform illustration.
 * Domain pure functions are source of truth for numbers (pretty ≠ correct).
 * Controls: pause / reset / step / keyboard; prefers-reduced-motion forces autoplay off;
 * text-alt via buildTextAlternative; interactive off / parse fail → staticFallbackModel.
 */

import {
  buildTextAlternative,
  formatVectorCells,
  parseMatrixTransformInteractionParams,
  parseMatrixTransformParams,
  staticFallbackModel,
  stepApply,
  stepPlan,
  type MatrixTransformInteractionParams,
  type MatrixTransformParams,
  type MatrixTransformStep,
  type StaticFallbackModel,
} from "@aistudy/domain";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ui } from "../../design/ui";

export const MATRIX_TRANSFORM_HONESTY_COPY =
  "图示只按同一组参数逐步演示，帮助理解过程，不代表答案一定正确。";

export const MATRIX_TRANSFORM_KEYSHORTCUTS =
  "Space Home ArrowLeft ArrowRight BracketLeft BracketRight";

export type MatrixTransformUiState = {
  stepIndex: number;
  paused: boolean;
  showTextAlt: boolean;
};

export function isMatrixTransformInteractiveEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = (
    env.OPENING_MATRIX_TRANSFORM_INTERACTIVE ??
    "1"
  )
    .trim()
    .toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  return true;
}

/** Content autoplay already defaults false; reduced-motion forces off. */
export function resolveEffectiveAutoplay(
  contentAutoplay: boolean,
  prefersReducedMotion: boolean,
): boolean {
  if (prefersReducedMotion) return false;
  return contentAutoplay === true;
}

export function readPrefersReducedMotion(
  mediaMatcher?: { matches: boolean } | null,
): boolean {
  if (mediaMatcher != null) return mediaMatcher.matches === true;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function clampStepIndex(index: number, stepCount: number): number {
  if (stepCount <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(index), stepCount - 1));
}

export function initialUiState(
  interaction: MatrixTransformInteractionParams | undefined,
  stepCount: number,
): MatrixTransformUiState {
  const soft = parseMatrixTransformInteractionParams(interaction ?? {});
  return {
    stepIndex: clampStepIndex(soft.stepIndex ?? 0, stepCount),
    paused: soft.paused ?? true,
    showTextAlt: soft.showTextAlt ?? false,
  };
}

export function advanceStep(
  state: MatrixTransformUiState,
  stepCount: number,
): MatrixTransformUiState {
  return {
    ...state,
    stepIndex: clampStepIndex(state.stepIndex + 1, stepCount),
    paused: true,
  };
}

export function retreatStep(
  state: MatrixTransformUiState,
  stepCount: number,
): MatrixTransformUiState {
  return {
    ...state,
    stepIndex: clampStepIndex(state.stepIndex - 1, stepCount),
    paused: true,
  };
}

export function resetUiState(
  stepCount: number,
  keepTextAlt = false,
): MatrixTransformUiState {
  return {
    stepIndex: clampStepIndex(0, stepCount),
    paused: true,
    showTextAlt: keepTextAlt,
  };
}

export function togglePaused(state: MatrixTransformUiState): MatrixTransformUiState {
  return { ...state, paused: !state.paused };
}

/**
 * Keyboard map (Plan §3 / a11y):
 * Space → pause/resume; Home → reset; ← / [ → step back; → / ] → step forward.
 * Returns null when unhandled.
 */
export function handleMatrixTransformKey(
  key: string,
  state: MatrixTransformUiState,
  stepCount: number,
): MatrixTransformUiState | null {
  switch (key) {
    case " ":
    case "Spacebar":
    case "Space":
      return togglePaused(state);
    case "Home":
      return { ...resetUiState(stepCount, state.showTextAlt) };
    case "ArrowRight":
    case "]":
      return advanceStep(state, stepCount);
    case "ArrowLeft":
    case "[":
      return retreatStep(state, stepCount);
    default:
      return null;
  }
}

export function toInteractionParams(
  state: MatrixTransformUiState,
): MatrixTransformInteractionParams {
  return parseMatrixTransformInteractionParams({
    paused: state.paused,
    stepIndex: state.stepIndex,
    showTextAlt: state.showTextAlt,
  });
}

function MatrixTable({
  label,
  rows,
  highlightCol,
  highlightRow,
}: {
  label: string;
  rows: string[][];
  highlightCol?: number;
  highlightRow?: number;
}) {
  return (
    <div className="space-y-1" data-matrix-label={label}>
      <p className="text-xs font-medium text-text-2">{label}</p>
      <table className="border-collapse font-mono text-xs tabular-nums text-text">
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => {
                const hi =
                  (highlightCol != null && ci === highlightCol) ||
                  (highlightRow != null &&
                    highlightCol != null &&
                    ri === highlightRow &&
                    ci === highlightCol);
                return (
                  <td
                    key={ci}
                    className={
                      hi
                        ? "border border-accent/40 bg-accent-soft px-2 py-1"
                        : "border border-line bg-surface px-2 py-1"
                    }
                    data-cell={`${ri},${ci}`}
                  >
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VectorRow({
  label,
  cells,
  highlight,
}: {
  label: string;
  cells: string[];
  highlight?: boolean;
}) {
  return (
    <div className="space-y-1" data-vector-label={label}>
      <p className="text-xs font-medium text-text-2">{label}</p>
      <table className="border-collapse font-mono text-xs tabular-nums text-text">
        <tbody>
          <tr>
            {cells.map((cell, i) => (
              <td
                key={i}
                className={
                  highlight
                    ? "border border-accent/40 bg-accent-soft px-2 py-1"
                    : "border border-line bg-surface px-2 py-1"
                }
                data-cell={i}
              >
                {cell}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Static table + 文字 from same params (PM lock 3 / rollback). */
export function MatrixTransformStaticView({
  model,
  textAlt,
  parseErrors,
  title,
}: {
  model: StaticFallbackModel;
  textAlt: string;
  parseErrors?: string[];
  title?: string;
}) {
  return (
    <div
      className="space-y-3 rounded-lg border border-line bg-surface px-3 py-3"
      data-catalog="matrix_transform"
      data-matrix-mode="static"
      role="group"
      aria-label={title ?? model.title ?? "矩阵变换（静态）"}
    >
      {(title ?? model.title) ? (
        <p className="text-sm font-medium text-text">{title ?? model.title}</p>
      ) : null}
      {model.expression ? (
        <p className="font-mono text-xs text-text-2">{model.expression}</p>
      ) : null}
      {parseErrors && parseErrors.length > 0 ? (
        <div
          className="rounded-md bg-warn-soft px-2 py-1.5 text-xs text-warn ring-1 ring-warn/20"
          role="status"
          data-math-params-error={parseErrors.join("; ")}
        >
          参数未完全通过校验，以下为尽力静态展示：{parseErrors.join("；")}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-4">
        <MatrixTable label={model.labelA} rows={model.rowsA} />
        <VectorRow label={model.labelX} cells={model.rowX} />
        <VectorRow label={model.labelY} cells={model.rowY} highlight />
      </div>
      {model.prose ? (
        <p className="whitespace-pre-wrap text-sm leading-6 text-text">{model.prose}</p>
      ) : null}
      <pre
        className="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-2 px-2 py-1.5 font-mono text-xs leading-5 text-text-2 ring-1 ring-line"
        data-text-alternative="true"
      >
        {textAlt}
      </pre>
      <p className="text-xs leading-5 text-text-3" data-matrix-honesty="true">
        {MATRIX_TRANSFORM_HONESTY_COPY}
      </p>
    </div>
  );
}

export type MatrixTransformViewProps = {
  params: MatrixTransformParams;
  state: MatrixTransformUiState;
  steps: MatrixTransformStep[];
  currentStep: MatrixTransformStep | null;
  prefersReducedMotion: boolean;
  effectiveAutoplay: boolean;
  onPauseToggle: () => void;
  onReset: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  onToggleTextAlt: () => void;
  onKeyDown?: (key: string) => void;
};

/**
 * Presentational interactive view — SSR-safe for vitest static markup.
 * Numbers come from domain stepApply / format helpers via parent.
 */
export function MatrixTransformView({
  params,
  state,
  steps,
  currentStep,
  prefersReducedMotion,
  effectiveAutoplay,
  onPauseToggle,
  onReset,
  onStepForward,
  onStepBack,
  onToggleTextAlt,
  onKeyDown,
}: MatrixTransformViewProps) {
  const model = staticFallbackModel(params);
  const textAlt = buildTextAlternative(params);
  // Domain formatVectorCells is source of truth for display rounding.
  const displayY =
    currentStep?.kind === "result" || !currentStep
      ? model.rowY
      : formatVectorCells(currentStep.partialY);

  return (
    <div
      className="space-y-3 rounded-lg border border-line bg-surface px-3 py-3"
      data-catalog="matrix_transform"
      data-matrix-mode="interactive"
      data-step-index={state.stepIndex}
      data-paused={state.paused ? "true" : "false"}
      data-reduced-motion={prefersReducedMotion ? "true" : "false"}
      data-effective-autoplay={effectiveAutoplay ? "true" : "false"}
      role="group"
      aria-label={params.title ?? "矩阵变换"}
      tabIndex={0}
      aria-keyshortcuts={MATRIX_TRANSFORM_KEYSHORTCUTS}
      onKeyDown={(e) => {
        if (!onKeyDown) return;
        const handled = handleMatrixTransformKey(
          e.key,
          state,
          steps.length,
        );
        if (handled) {
          e.preventDefault();
          onKeyDown(e.key);
        }
      }}
    >
      {params.title ? (
        <p className="text-sm font-medium text-text">{params.title}</p>
      ) : null}
      {params.expression ? (
        <p className="font-mono text-xs text-text-2">{params.expression}</p>
      ) : null}

      <div
        className="flex flex-wrap gap-1"
        role="toolbar"
        aria-label="矩阵变换控制"
        data-matrix-controls="true"
      >
        <button
          type="button"
          className={ui.secondary}
          data-matrix-action="pause"
          aria-pressed={state.paused}
          aria-label={state.paused ? "继续" : "暂停"}
          onClick={onPauseToggle}
        >
          {state.paused ? "继续" : "暂停"}
        </button>
        <button
          type="button"
          className={ui.secondary}
          data-matrix-action="reset"
          aria-label="重置"
          onClick={onReset}
        >
          重置
        </button>
        <button
          type="button"
          className={ui.secondary}
          data-matrix-action="step-back"
          aria-label="上一步"
          disabled={state.stepIndex <= 0}
          onClick={onStepBack}
        >
          上一步
        </button>
        <button
          type="button"
          className={ui.secondary}
          data-matrix-action="step-forward"
          aria-label="下一步"
          disabled={state.stepIndex >= Math.max(0, steps.length - 1)}
          onClick={onStepForward}
        >
          下一步
        </button>
        <button
          type="button"
          className={ui.secondary}
          data-matrix-action="text-alt"
          aria-pressed={state.showTextAlt}
          aria-label="文字替代"
          onClick={onToggleTextAlt}
        >
          文字替代
        </button>
      </div>

      <p
        className="text-xs leading-5 text-text-3"
        data-matrix-step-label="true"
        aria-live="polite"
      >
        步骤 {steps.length === 0 ? 0 : state.stepIndex + 1}/{steps.length}
        {currentStep ? ` — ${currentStep.label}` : ""}
        {prefersReducedMotion ? "（已尊重减少动效：自动播放关闭）" : ""}
      </p>

      <div className="flex flex-wrap gap-4">
        <MatrixTable
          label={model.labelA}
          rows={model.rowsA}
          highlightCol={currentStep?.col}
          highlightRow={currentStep?.row}
        />
        <VectorRow label={model.labelX} cells={model.rowX} />
        <VectorRow
          label={model.labelY}
          cells={displayY}
          highlight={currentStep?.kind === "result"}
        />
      </div>

      {state.showTextAlt ? (
        <pre
          className="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-2 px-2 py-1.5 font-mono text-xs leading-5 text-text-2 ring-1 ring-line"
          data-text-alternative="true"
        >
          {textAlt}
        </pre>
      ) : null}

      <p className="text-xs leading-5 text-text-3" data-matrix-honesty="true">
        {MATRIX_TRANSFORM_HONESTY_COPY}
      </p>
    </div>
  );
}

export type MatrixTransformBlockProps = {
  /** Block content / params bag (same semantic MatrixTransformParams). */
  content: unknown;
  /** When false → static table + 文字 (rollback / flag). Default true. */
  interactive?: boolean;
  /** Soft checkpoint interactionParams[blockId]; empty OK. */
  initialInteraction?: unknown;
  /**
   * Soft notify of local UI state. Persistence via V2-14 checkpoint POST
   * may be thin this slice — soft gap OK if not fully wired.
   */
  onInteractionChange?: (next: MatrixTransformInteractionParams) => void;
  /** Test / SSR override for prefers-reduced-motion. */
  prefersReducedMotion?: boolean;
};

/**
 * Mount point for catalog id matrix_transform.
 * Parse OK + interactive → stepper; else staticFallbackModel (never empty unknown when parse OK).
 */
export function MatrixTransformBlock({
  content,
  interactive = true,
  initialInteraction,
  onInteractionChange,
  prefersReducedMotion: prefersReducedMotionProp,
}: MatrixTransformBlockProps) {
  const parsed = useMemo(() => parseMatrixTransformParams(content), [content]);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () => prefersReducedMotionProp ?? readPrefersReducedMotion(),
  );

  useEffect(() => {
    if (prefersReducedMotionProp != null) {
      setPrefersReducedMotion(prefersReducedMotionProp);
      return;
    }
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setPrefersReducedMotion(mq.matches);
    sync();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", sync);
      return () => mq.removeEventListener("change", sync);
    }
    // Safari legacy
    mq.addListener(sync);
    return () => mq.removeListener(sync);
  }, [prefersReducedMotionProp]);

  if (!parsed.ok) {
    // Parse fail: honesty + retain error; no invented matrices.
    return (
      <div
        className="space-y-2 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2"
        data-catalog="matrix_transform"
        data-matrix-mode="parse-fail"
        data-math-params-error={parsed.errors.join("; ")}
        role="status"
      >
        <p className="text-xs font-medium text-warn">
          矩阵参数无法解析，已跳过交互图示（不伪造数值）。
        </p>
        <ul className="list-disc pl-4 text-xs text-warn">
          {parsed.errors.map((err, i) => (
            <li key={i}>{err}</li>
          ))}
        </ul>
        <p className="text-xs text-text-3">{MATRIX_TRANSFORM_HONESTY_COPY}</p>
      </div>
    );
  }

  const params = parsed.value;

  if (!interactive) {
    const model = staticFallbackModel(params);
    return (
      <MatrixTransformStaticView
        model={model}
        textAlt={buildTextAlternative(params)}
        title={params.title}
      />
    );
  }

  return (
    <MatrixTransformInteractive
      params={params}
      prefersReducedMotion={prefersReducedMotion}
      initialInteraction={initialInteraction}
      onInteractionChange={onInteractionChange}
    />
  );
}

function MatrixTransformInteractive({
  params,
  prefersReducedMotion,
  initialInteraction,
  onInteractionChange,
}: {
  params: MatrixTransformParams;
  prefersReducedMotion: boolean;
  initialInteraction?: unknown;
  onInteractionChange?: (next: MatrixTransformInteractionParams) => void;
}) {
  const steps = useMemo(() => stepPlan(params), [params]);
  const [state, setState] = useState<MatrixTransformUiState>(() =>
    initialUiState(
      parseMatrixTransformInteractionParams(initialInteraction),
      steps.length,
    ),
  );

  const effectiveAutoplay = resolveEffectiveAutoplay(
    params.autoplay,
    prefersReducedMotion,
  );

  // Reduced-motion / autoplay-off: freeze; never start a timer when forced off.
  useEffect(() => {
    if (!effectiveAutoplay || state.paused) return;
    if (steps.length <= 1) return;
    const id = window.setInterval(() => {
      setState((prev) => {
        if (prev.stepIndex >= steps.length - 1) {
          return { ...prev, paused: true };
        }
        return advanceStep(prev, steps.length);
      });
    }, 900);
    return () => window.clearInterval(id);
  }, [effectiveAutoplay, state.paused, steps.length]);

  const emit = useCallback(
    (next: MatrixTransformUiState) => {
      setState(next);
      onInteractionChange?.(toInteractionParams(next));
    },
    [onInteractionChange],
  );

  const applied = stepApply(params, state.stepIndex);

  const onKeyDown = useCallback(
    (key: string) => {
      const next = handleMatrixTransformKey(key, state, steps.length);
      if (next) emit(next);
    },
    [emit, state, steps.length],
  );

  return (
    <MatrixTransformView
      params={params}
      state={state}
      steps={steps}
      currentStep={applied.step}
      prefersReducedMotion={prefersReducedMotion}
      effectiveAutoplay={effectiveAutoplay}
      onPauseToggle={() => emit(togglePaused(state))}
      onReset={() => emit(resetUiState(steps.length, state.showTextAlt))}
      onStepForward={() => emit(advanceStep(state, steps.length))}
      onStepBack={() => emit(retreatStep(state, steps.length))}
      onToggleTextAlt={() =>
        emit({ ...state, showTextAlt: !state.showTextAlt })
      }
      onKeyDown={onKeyDown}
    />
  );
}
