import type { z } from "zod";

export class OpeningResponseError extends Error {
  constructor(cause: z.ZodError) {
    super("暂时读不懂服务器返回的内容。请先刷新看看当前状态，再决定是否重试。", { cause });
    this.name = "OpeningResponseError";
  }
}

/** Response validation stays strict; schema diagnostics belong to the cause, not learner-facing copy. */
export function parseOpeningResponse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new OpeningResponseError(result.error);
  return result.data;
}
