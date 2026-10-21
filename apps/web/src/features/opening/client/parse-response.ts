import type { z } from "zod";

export class OpeningResponseError extends Error {
  constructor(cause: z.ZodError) {
    super("服务器返回的数据暂时无法核验。请先重新读取当前状态，再决定是否重试。", { cause });
    this.name = "OpeningResponseError";
  }
}

/** Response validation stays strict; schema diagnostics belong to the cause, not learner-facing copy. */
export function parseOpeningResponse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new OpeningResponseError(result.error);
  return result.data;
}
