import { buildTextAlternative, parseMatrixTransformParams } from "@aistudy/domain";
import { decideBlock } from "@aistudy/jingwei";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlockRenderer } from "./block-renderer";
import {
  MATRIX_TRANSFORM_CAPABILITY_ID,
  teachingArtifactBlock,
  teachingCapabilities,
} from "./teaching-capabilities";

const BID = "11111111-1111-4111-8111-111111111111";
const content = { matrixA: [[2, 0], [0, 3]], vectorX: [1, 1], title: "伸缩" };

describe("teaching capabilities", () => {
  it("registers matrix-transform@1 with a planner-readable schema", () => {
    const [descriptor] = teachingCapabilities.describe();
    expect(descriptor).toMatchObject({ id: MATRIX_TRANSFORM_CAPABILITY_ID, modes: ["text", "static", "interactive"] });
    expect(descriptor!.paramsSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["matrixA", "vectorX"]) });
  });

  it("text mode is the domain text alternative for the same params", () => {
    const decision = decideBlock(teachingArtifactBlock(BID, MATRIX_TRANSFORM_CAPABILITY_ID, content), teachingCapabilities, {
      textOnly: true,
    });
    const parsed = parseMatrixTransformParams(content);
    expect(decision.ok && parsed.ok).toBe(true);
    if (decision.ok && parsed.ok) expect(decision.text).toBe(buildTextAlternative(parsed.value));
  });

  it("invalid matrix content keeps the block's own parse-fail card", () => {
    const html = renderToStaticMarkup(
      createElement(BlockRenderer, {
        block: { blockId: BID, position: 0, blockType: "matrix_transform", role: "teach", content: { matrixA: [[1, 2]], vectorX: [1] } },
      }),
    );
    expect(html).toContain('data-matrix-mode="parse-fail"');
    expect(html).toContain("不伪造数值");
  });
});
