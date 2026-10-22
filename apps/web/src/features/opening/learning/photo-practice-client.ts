import { z } from "zod";
import { OpeningApiError } from "../client/api";

const inputSchema = z.object({ sourceId: z.string().uuid(), sourceVersion: z.number().int().positive() });
const resultSchema = inputSchema.extend({ courseId: z.string().uuid() }).strict();
export type PreparedPhotoPractice = z.infer<typeof resultSchema>;

export async function preparePhotoPractice(input: z.infer<typeof inputSchema>, fetcher: typeof fetch = fetch): Promise<PreparedPhotoPractice> {
  const response = await fetcher("/api/opening/practice/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(inputSchema.parse(input)) });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    throw new OpeningApiError(response.status, error.success ? error.data.error.message : "暂时无法开始作答，题图和题干已保留。");
  }
  const result = resultSchema.parse(body);
  if (result.sourceId !== input.sourceId || result.sourceVersion !== input.sourceVersion) throw new Error("题图版本已改变，请核对当前题图后再开始。");
  return result;
}
