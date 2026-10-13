"use client";

/**
 * Teaching host adapter for jingwei: registers teaching renderers as capabilities so
 * the same catalog serves chat, notes and other agents. Teaching-only rules
 * (answer_key gating, block aliases) stay in component-catalog.ts.
 */

import { matrixTransformParamsSchema, type MatrixTransformParams } from "@aistudy/contracts";
import { buildTextAlternative } from "@aistudy/domain";
import { createCapabilityRegistry, defineCapability, type ArtifactBlock } from "@aistudy/jingwei";
import { defineRenderer, type RendererMap } from "@aistudy/jingwei/react";
import { MatrixTransformBlock } from "./blocks/matrix-transform";

export const MATRIX_TRANSFORM_CAPABILITY_ID = "matrix-transform@1";

export const matrixTransformCapability = defineCapability<MatrixTransformParams>({
  id: MATRIX_TRANSFORM_CAPABILITY_ID,
  title: "矩阵作用于向量（逐步演示）",
  tasks: ["process", "explore"],
  modes: ["text", "static", "interactive"],
  params: matrixTransformParamsSchema,
  limits: ["实数矩阵，最大 4×4", "图示按同一参数模型逐步展示，不构成证明"],
  toText: buildTextAlternative,
});

export const teachingCapabilities = createCapabilityRegistry([matrixTransformCapability]);

export const teachingRenderers: RendererMap = {
  [MATRIX_TRANSFORM_CAPABILITY_ID]: defineRenderer<MatrixTransformParams>(({ params, mode, prefs }) => (
    <MatrixTransformBlock
      content={params}
      interactive={mode === "interactive"}
      prefersReducedMotion={prefs.reducedMotion}
    />
  )),
};

/** Teaching blocks carry no actions or limits of their own yet; the capability limits apply. */
export function teachingArtifactBlock(blockId: string, capability: string, params: unknown): ArtifactBlock {
  return { id: blockId, capability, params, allowedActions: [], limits: [], sourceRefs: [] };
}
