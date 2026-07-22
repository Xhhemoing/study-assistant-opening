import { z } from "zod";

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

export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const workerSmokeJobSchema = z.object({
  kind: z.literal("smoke"),
  message: z.string().min(1),
});

export type WorkerSmokeJob = z.infer<typeof workerSmokeJobSchema>;
