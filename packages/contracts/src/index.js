import { z } from "zod";
export const healthResponseSchema = z.object({
    status: z.literal("ok"),
    service: z.string().min(1),
});
export const workerSmokeJobSchema = z.object({
    kind: z.literal("smoke"),
    message: z.string().min(1),
});
//# sourceMappingURL=index.js.map