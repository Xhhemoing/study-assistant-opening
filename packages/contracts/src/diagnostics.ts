import { z } from "zod";
import { attemptEventSchema } from "./attempts";
import { statusResultSchema } from "./assessment";

export const diagnosticsSchema = z.object({
  versions: z.record(z.string(), z.string()),
  recentAttemptEvents: z.array(attemptEventSchema).max(20),
  statuses: z.array(statusResultSchema),
  planTaskReasons: z.array(z.object({ taskId: z.string(), reason: z.string() })),
});

export type Diagnostics = z.infer<typeof diagnosticsSchema>;
