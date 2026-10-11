/**
 * V2-15 teaching math model — MatrixTransformParams contracts (new file only).
 * Do not fold into teaching-content.ts (PM lock 5 / Data co-review).
 * M1: real numbers only, ≤4×4; complex/symbolic OOS. No DDL.
 */
import { z } from "zod";

/** Max matrix dimension (rows and cols). */
export const MATRIX_TRANSFORM_MAX_DIM = 4 as const;

/** Max absolute value for any finite entry. */
export const MATRIX_TRANSFORM_MAX_ABS = 1e6 as const;

/** Display rounding for text-alt / static fallback (stable decimals). */
export const MATRIX_TRANSFORM_DISPLAY_DECIMALS = 6 as const;

export const matrixTransformStepModeSchema = z.enum([
  "by_entry",
  "by_column",
  "all_at_once",
]);
export type MatrixTransformStepMode = z.infer<
  typeof matrixTransformStepModeSchema
>;

const finiteRealSchema = z
  .number()
  .finite()
  .gte(-MATRIX_TRANSFORM_MAX_ABS)
  .lte(MATRIX_TRANSFORM_MAX_ABS);

/**
 * Row-major rectangular matrix of reals; 1..MAX_DIM rows/cols; abs ≤ MAX_ABS.
 */
export const matrixSchema = z
  .array(z.array(finiteRealSchema).min(1).max(MATRIX_TRANSFORM_MAX_DIM))
  .min(1)
  .max(MATRIX_TRANSFORM_MAX_DIM)
  .superRefine((rows, ctx) => {
    const cols = rows[0]?.length ?? 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]!.length !== cols) {
        ctx.addIssue({
          code: "custom",
          message: `matrix must be rectangular; row ${i} length ${rows[i]!.length} ≠ ${cols}`,
          path: [i],
        });
      }
    }
  });

export type Matrix = z.infer<typeof matrixSchema>;

export const matrixTransformParamsSchema = z
  .object({
    version: z.literal(1).default(1),
    matrixA: matrixSchema,
    vectorX: z
      .array(finiteRealSchema)
      .min(1)
      .max(MATRIX_TRANSFORM_MAX_DIM),
    /** Optional explicit output; if omitted, domain computes A·x. */
    vectorY: z
      .array(finiteRealSchema)
      .min(1)
      .max(MATRIX_TRANSFORM_MAX_DIM)
      .optional(),
    labelA: z.string().max(80).optional(),
    labelX: z.string().max(80).optional(),
    labelY: z.string().max(80).optional(),
    title: z.string().max(120).optional(),
    prose: z.string().max(2000).optional(),
    expression: z.string().max(200).optional(),
    stepMode: matrixTransformStepModeSchema.default("by_column"),
    /** Content-level default; reduced-motion is Experience — domain default stays false. */
    autoplay: z.boolean().default(false),
  })
  .strict()
  .superRefine((val, ctx) => {
    const cols = val.matrixA[0]?.length ?? 0;
    const rows = val.matrixA.length;
    if (val.vectorX.length !== cols) {
      ctx.addIssue({
        code: "custom",
        message: `vectorX length ${val.vectorX.length} ≠ matrixA cols ${cols}`,
        path: ["vectorX"],
      });
    }
    if (val.vectorY !== undefined && val.vectorY.length !== rows) {
      ctx.addIssue({
        code: "custom",
        message: `vectorY length ${val.vectorY.length} ≠ matrixA rows ${rows}`,
        path: ["vectorY"],
      });
    }
  });

export type MatrixTransformParams = z.infer<typeof matrixTransformParamsSchema>;

/**
 * Soft runtime UI state nested under checkpoint interactionParams[blockId].
 * Empty / partial OK — not authoritative math.
 */
export const matrixTransformInteractionParamsSchema = z
  .object({
    paused: z.boolean().optional(),
    stepIndex: z.number().int().nonnegative().optional(),
    showTextAlt: z.boolean().optional(),
  })
  .strict();

export type MatrixTransformInteractionParams = z.infer<
  typeof matrixTransformInteractionParamsSchema
>;
