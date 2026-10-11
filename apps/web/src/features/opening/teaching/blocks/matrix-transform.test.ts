import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildTextAlternative,
  formatVectorCells,
  staticFallbackModel,
  stepPlan,
} from "@aistudy/domain";
import {
  MATRIX_TRANSFORM_HONESTY_COPY,
  MATRIX_TRANSFORM_KEYSHORTCUTS,
  MatrixTransformStaticView,
  MatrixTransformView,
  advanceStep,
  clampStepIndex,
  handleMatrixTransformKey,
  initialUiState,
  isMatrixTransformInteractiveEnabled,
  resetUiState,
  resolveEffectiveAutoplay,
  retreatStep,
  toInteractionParams,
  togglePaused,
  type MatrixTransformUiState,
} from "./matrix-transform";

const FIXTURE = {
  matrixA: [
    [1, 1],
    [0, 0],
  ],
  vectorX: [1, -1],
  labelA: "A",
  labelX: "x",
  labelY: "Ax",
  title: "秩一核示例",
  expression: "y = Ax",
  prose: "核向量映到零。",
  stepMode: "by_column" as const,
  autoplay: false,
};

function baseState(over: Partial<MatrixTransformUiState> = {}): MatrixTransformUiState {
  return { stepIndex: 0, paused: true, showTextAlt: false, ...over };
}

describe("matrix-transform state machine (T14)", () => {
  it("clamp / advance / retreat / reset / togglePaused", () => {
    const steps = stepPlan({
      version: 1,
      ...FIXTURE,
      autoplay: false,
      stepMode: "by_column",
    });
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(clampStepIndex(-1, steps.length)).toBe(0);
    expect(clampStepIndex(99, steps.length)).toBe(steps.length - 1);

    let s = baseState();
    s = advanceStep(s, steps.length);
    expect(s.stepIndex).toBe(1);
    expect(s.paused).toBe(true);
    s = retreatStep(s, steps.length);
    expect(s.stepIndex).toBe(0);
    s = togglePaused(s);
    expect(s.paused).toBe(false);
    s = resetUiState(steps.length, true);
    expect(s).toEqual({ stepIndex: 0, paused: true, showTextAlt: true });
  });

  it("keyboard: Space pause, Home reset, arrows/brackets step", () => {
    const n = 3;
    let s = baseState({ paused: false, stepIndex: 1 });
    s = handleMatrixTransformKey(" ", s, n)!;
    expect(s.paused).toBe(true);
    s = handleMatrixTransformKey("ArrowRight", s, n)!;
    expect(s.stepIndex).toBe(2);
    s = handleMatrixTransformKey("[", s, n)!;
    expect(s.stepIndex).toBe(1);
    s = handleMatrixTransformKey("Home", s, n)!;
    expect(s.stepIndex).toBe(0);
    expect(s.paused).toBe(true);
    expect(handleMatrixTransformKey("Enter", s, n)).toBeNull();
  });

  it("soft interactionParams empty default OK", () => {
    const s = initialUiState({}, 4);
    expect(s.stepIndex).toBe(0);
    expect(s.paused).toBe(true);
    expect(s.showTextAlt).toBe(false);
    const soft = initialUiState({ stepIndex: 2, paused: false, showTextAlt: true }, 4);
    expect(soft).toEqual({ stepIndex: 2, paused: false, showTextAlt: true });
    expect(toInteractionParams(soft)).toMatchObject({
      stepIndex: 2,
      paused: false,
      showTextAlt: true,
    });
  });
});

describe("reduced-motion / autoplay (T15)", () => {
  it("prefers-reduced-motion forces autoplay off even if content says true", () => {
    expect(resolveEffectiveAutoplay(true, true)).toBe(false);
    expect(resolveEffectiveAutoplay(false, true)).toBe(false);
    expect(resolveEffectiveAutoplay(true, false)).toBe(true);
    expect(resolveEffectiveAutoplay(false, false)).toBe(false);
  });

  it("interactive flag defaults on; off via env", () => {
    expect(isMatrixTransformInteractiveEnabled({})).toBe(true);
    expect(
      isMatrixTransformInteractiveEnabled({
        OPENING_MATRIX_TRANSFORM_INTERACTIVE: "0",
      }),
    ).toBe(false);
    expect(
      isMatrixTransformInteractiveEnabled({
        NEXT_PUBLIC_OPENING_MATRIX_TRANSFORM_INTERACTIVE: "false",
      }),
    ).toBe(false);
  });
});

describe("MatrixTransformStaticView (T16)", () => {
  it("renders tables + 文字 from staticFallbackModel / buildTextAlternative", () => {
    const params = {
      version: 1 as const,
      ...FIXTURE,
      autoplay: false,
      stepMode: "by_column" as const,
    };
    const model = staticFallbackModel(params);
    const textAlt = buildTextAlternative(params);
    const html = renderToStaticMarkup(
      createElement(MatrixTransformStaticView, {
        model,
        textAlt,
        title: params.title,
      }),
    );
    expect(html).toContain('data-catalog="matrix_transform"');
    expect(html).toContain('data-matrix-mode="static"');
    expect(html).toContain("秩一核示例");
    expect(html).toContain("y = Ax");
    expect(html).toContain("核向量映到零");
    expect(html).toContain('data-text-alternative="true"');
    expect(html).toContain(MATRIX_TRANSFORM_HONESTY_COPY);
    // Same numbers as domain — kernel → zeros
    expect(model.rowY).toEqual(formatVectorCells([0, 0]));
    expect(html).toContain(model.rowY[0]!);
    expect(textAlt).toContain("A");
    expect(textAlt).toContain("x");
  });
});

describe("MatrixTransformView interactive chrome (T14)", () => {
  it("exposes pause/reset/step/text-alt + keyboard shortcuts + reduced-motion attrs", () => {
    const params = {
      version: 1 as const,
      ...FIXTURE,
      autoplay: false,
      stepMode: "by_column" as const,
    };
    const steps = stepPlan(params);
    const state = baseState({ showTextAlt: true });
    const html = renderToStaticMarkup(
      createElement(MatrixTransformView, {
        params,
        state,
        steps,
        currentStep: steps[0]!,
        prefersReducedMotion: true,
        effectiveAutoplay: false,
        onPauseToggle: () => undefined,
        onReset: () => undefined,
        onStepForward: () => undefined,
        onStepBack: () => undefined,
        onToggleTextAlt: () => undefined,
        onKeyDown: vi.fn(),
      }),
    );
    expect(html).toContain('data-matrix-mode="interactive"');
    expect(html).toContain('data-matrix-controls="true"');
    expect(html).toContain('data-matrix-action="pause"');
    expect(html).toContain('data-matrix-action="reset"');
    expect(html).toContain('data-matrix-action="step-forward"');
    expect(html).toContain('data-matrix-action="step-back"');
    expect(html).toContain('data-matrix-action="text-alt"');
    expect(html).toContain('data-reduced-motion="true"');
    expect(html).toContain('data-effective-autoplay="false"');
    expect(html).toContain("已尊重减少动效");
    expect(html).toContain('data-text-alternative="true"');
    expect(html).toContain(MATRIX_TRANSFORM_KEYSHORTCUTS);
    expect(html).toContain(MATRIX_TRANSFORM_HONESTY_COPY);
  });
});
