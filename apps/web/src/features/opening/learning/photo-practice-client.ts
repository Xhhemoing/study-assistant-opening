import { z } from "zod";
import { OpeningApiError } from "../client/api";
import { photoQuestionRecognitionInputSchema, photoQuestionRecognitionResponseSchema, type PhotoQuestionRecognitionInput } from "@aistudy/contracts";

const inputSchema = z.object({ sourceId: z.string().uuid(), sourceVersion: z.number().int().nonnegative() });
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

/** Reading never creates a job or sends a model request. POST reuses the same source/version job. */
export async function photoQuestionRecognition(raw: PhotoQuestionRecognitionInput, start = false, fetcher: typeof fetch = fetch) {
  const input = photoQuestionRecognitionInputSchema.parse(raw);
  const query = new URLSearchParams({ sourceId: input.sourceId, sourceVersion: String(input.sourceVersion) });
  const response = await fetcher(`/api/opening/practice/recognition${start ? "" : `?${query}`}`, start
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }
    : { cache: "no-store" });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    throw new OpeningApiError(response.status, error.success ? error.data.error.message : "暂时无法读取识别结果；仍可手动填写题干。");
  }
  const result = photoQuestionRecognitionResponseSchema.parse(body);
  if (result.sourceId !== input.sourceId || result.sourceVersion !== input.sourceVersion) throw new Error("识别结果与当前题图版本不一致，请核对原图。");
  return result;
}
