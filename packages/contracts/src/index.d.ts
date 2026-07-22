import { z } from "zod";
export declare const healthResponseSchema: z.ZodObject<{
    status: z.ZodLiteral<"ok">;
    service: z.ZodString;
}, z.core.$strip>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export declare const workerSmokeJobSchema: z.ZodObject<{
    kind: z.ZodLiteral<"smoke">;
    message: z.ZodString;
}, z.core.$strip>;
export type WorkerSmokeJob = z.infer<typeof workerSmokeJobSchema>;
//# sourceMappingURL=index.d.ts.map