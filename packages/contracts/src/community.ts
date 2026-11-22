import { z } from "zod";

// Public root for the Community Edition's portable V1/V2 contracts.
export * from "./promotions";
export * from "./revision-proposal";
export * from "./workspace";
export * from "./assets";
export * from "./auth";
export * from "./workspace-preferences";
export * from "./goals";
export * from "./attempts";
export * from "./practice-content";
export * from "./learning-read-models";
export * from "./learning-events";
export * from "./assessment";
export * from "./plan";
export * from "./srs";
export * from "./diagnostics";
export * from "./ai-jobs";
export * from "./search";
export * from "./tags";
export * from "./course-requirements";
export * from "./properties";
export * from "./backup";
export * from "./portability";
export * from "./relations";

export const dependencyStatusSchema = z.object({
  status: z.enum(["up", "down"]),
  latencyMs: z.number().nonnegative().optional(),
  errorCode: z.string().optional(),
});

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  service: z.string().min(1),
  checks: z.object({
    database: dependencyStatusSchema,
    redis: dependencyStatusSchema,
    storage: dependencyStatusSchema,
  }),
});

export const workerSmokeJobSchema = z.object({
  kind: z.literal("smoke"),
  message: z.string().min(1),
});

export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type WorkerSmokeJob = z.infer<typeof workerSmokeJobSchema>;
