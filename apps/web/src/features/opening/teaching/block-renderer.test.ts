import { createElement } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BLOCK_RENDERER_FORBIDS_RAW_HTML,
  BlockRenderer,
  renderClientInitBlocks,
} from "./block-renderer";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { OpeningCapabilitiesContext } from "../capabilities/capabilities-provider";

/** PR-H: interactivity comes from server capabilities via context, not client env. */
function withCaps(matrixTransformInteractive: boolean, element: ReturnType<typeof createElement>) {
  return createElement(OpeningCapabilitiesContext.Provider, { value: { ...CLOSED_CAPABILITIES, matrixTransformInteractive } }, element);
}

const BID = "11111111-1111-4111-8111-111111111111";
const BID2 = "22222222-2222-4222-8222-222222222222";
const SRC = "33333333-3333-4333-8333-333333333333";

describe("BlockRenderer", () => {
  it("carries the generated question topic into the inline answer form", () => {
    const html = renderToStaticMarkup(createElement(BlockRenderer, {
      block: { blockId: BID, position: 0, blockType: "prompt", role: "prompt", content: { text: "求矩阵秩。", skillLabel: "矩阵秩" } },
      attemptContext: { id: BID, courseId: SRC, sourceIds: [], contentVersion: 1, intentSummary: "模拟练习", status: "active",
        outlineTitle: "整节练习标题", onCourseAssociated: () => undefined },
    }));
    expect(html).toContain("矩阵秩");
    expect(html).not.toContain("记录的技能");
    expect(html).not.toContain('value="整节练习标题"');
  });
  it("renders text / math / step allowlist blocks as plain React text", () => {
    const textHtml = renderToStaticMarkup(
      createElement(BlockRenderer, {
        block: {
          blockId: BID,
          position: 0,
          blockType: "text",
          role: "teach",
          content: { text: "线性代数导论" },
        },
      }),
    );
    expect(textHtml).toContain("线性代数导论");
    expect(textHtml).toContain('data-catalog="text"');

    const mathHtml = renderToStaticMarkup(
      createElement(BlockRenderer, {
        block: {
          blockId: BID,
          position: 0,
          blockType: "formula",
          role: "teach",
          content: { latex: "A x = b" },
        },
      }),
    );
    expect(mathHtml).toContain("A x = b");
    expect(mathHtml).toContain('data-catalog="math"');
    expect(mathHtml).toContain("公式：");

    const stepHtml = renderToStaticMarkup(
      createElement(BlockRenderer, {
        block: {
          blockId: BID,
          position: 0,
          blockType: "steps",
          role: "teach",
          content: { steps: ["写出矩阵", "求行列式"] },
        },
      }),
    );
    expect(stepHtml).toContain("写出矩阵");
    expect(stepHtml).toContain('data-catalog="step"');
  });

  it("fail-soft unknown / hidden answer while continuing sibling blocks (C1/C2)", () => {
    const decisions = renderClientInitBlocks(
      {
        blocks: [
          {
            blockId: BID,
            position: 0,
            blockType: "text",
            role: "teach",
            content: { text: "ok" },
          },
          {
            blockId: BID2,
            position: 1,
            blockType: "answer_key",
            role: "answer_key",
            content: null,
            answerRef: { refId: BID2, revealState: "hidden" },
          },
        ],
        generationConfig: {},
        sourceRefs: [],
      },
      null,
    );
    expect(decisions[0]).toMatchObject({ ok: true, catalogId: "text" });
    expect(decisions[1]).toMatchObject({ ok: false, reason: "answer_hidden" });

    const hiddenHtml = renderToStaticMarkup(
      createElement(BlockRenderer, {
        block: {
          blockId: BID2,
          position: 1,
          blockType: "answer_key",
          role: "answer_key",
          content: null,
          answerRef: { refId: BID2, revealState: "hidden" },
        },
      }),
    );
    expect(hiddenHtml).toContain("data-block-fail-soft=\"answer_hidden\"");
    expect(hiddenHtml).not.toContain("secret-answer");
  });

  it("does not use dangerouslySetInnerHTML of model HTML (C9)", () => {
    expect(BLOCK_RENDERER_FORBIDS_RAW_HTML).toBe(true);
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "block-renderer.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/eval\s*\(/);
  });

  it("renders evidence from sourceRefs without MediaReader", () => {
    const html = renderToStaticMarkup(
      createElement(BlockRenderer, {
        block: {
          blockId: BID,
          position: 0,
          blockType: "evidence",
          role: "meta",
          content: { text: "引用材料" },
        },
        sourceRefs: [{ sourceId: SRC, page: 3 }],
      }),
    );
    expect(html).toContain("引用材料");
    expect(html).toContain("p.3");
    expect(html).not.toContain("MediaReader");
  });

  it("T17: mounts matrix_transform interactive path; unknown still fail-soft", () => {
    const matrixHtml = renderToStaticMarkup(withCaps(true,
      createElement(BlockRenderer, {
        block: {
          blockId: BID,
          position: 0,
          blockType: "matrix_transform",
          role: "teach",
          content: {
            matrixA: [
              [1, 1],
              [0, 0],
            ],
            vectorX: [1, -1],
            labelA: "A",
            labelX: "x",
            labelY: "Ax",
            title: "核示例",
            expression: "y = Ax",
            prose: "核向量映到零。",
          },
        },
      }),
    ));
    expect(matrixHtml).toContain('data-catalog="matrix_transform"');
    expect(matrixHtml).toContain("核示例");
    expect(matrixHtml).toContain("y = Ax");
    // Interactive default: controls present
    expect(matrixHtml).toContain('data-matrix-controls="true"');
    expect(matrixHtml).toContain('data-matrix-action="pause"');
    expect(matrixHtml).toContain('data-matrix-action="reset"');
    expect(matrixHtml).toContain('data-matrix-action="step-forward"');

    const aliasHtml = renderToStaticMarkup(
      createElement(BlockRenderer, {
        block: {
          blockId: BID2,
          position: 1,
          blockType: "matrix-viz",
          role: "teach",
          content: {
            matrixA: [[2, 0], [0, 2]],
            vectorX: [1, 1],
            expression: "y = 2x",
          },
        },
      }),
    );
    expect(aliasHtml).toContain('data-catalog="matrix_transform"');
    expect(aliasHtml).toContain('data-catalog-id="matrix_transform"');

    const unknownHtml = renderToStaticMarkup(
      createElement(BlockRenderer, {
        block: {
          blockId: BID,
          position: 0,
          blockType: "OpenMAICWidget",
          role: "teach",
          content: { text: "nope" },
        },
      }),
    );
    expect(unknownHtml).toContain('data-block-fail-soft="unknown_component"');
  });

  it("T17b: matrix_transform with interactive capability off → static tables", () => {
    const html = renderToStaticMarkup(withCaps(false,
      createElement(BlockRenderer, {
        block: {
          blockId: BID,
          position: 0,
          blockType: "matrix_transform",
          role: "teach",
          content: {
            matrixA: [[1, 0], [0, 1]],
            vectorX: [3, 4],
            title: "单位阵",
          },
        },
      }),
    ));
    expect(html).toContain('data-matrix-mode="static"');
    expect(html).toContain('data-text-alternative="true"');
    expect(html).toContain("单位阵");
    expect(html).not.toContain('data-matrix-controls="true"');
  });

  it("PR-H: without a capabilities response the block fails closed to static", () => {
    process.env.OPENING_MATRIX_TRANSFORM_INTERACTIVE = "1";
    try {
      const html = renderToStaticMarkup(
        createElement(BlockRenderer, {
          block: { blockId: BID, position: 0, blockType: "matrix_transform", role: "teach", content: { matrixA: [[1, 0], [0, 1]], vectorX: [1, 2] } },
        }),
      );
      expect(html).toContain('data-matrix-mode="static"');
    } finally {
      delete process.env.OPENING_MATRIX_TRANSFORM_INTERACTIVE;
    }
  });

});
