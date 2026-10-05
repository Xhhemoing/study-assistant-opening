import { z } from "zod";
export function materialAnalysisHref(sourceId: string, page = 1) {
  return `/opening/assistant?source=${encodeURIComponent(sourceId)}&page=${page}`;
}
export function materialAnalysisEntry(source?: string, page?: string) {
  const parsed = z.object({ source: z.string().uuid(), page: z.coerce.number().int().positive().max(2000) }).safeParse({ source, page: page ?? "1" });
  if (!parsed.success) return null;
  return { initialSourceIds: [parsed.data.source], initialPage: parsed.data.page, startFresh: true,
    initialTitle: "资料分析", initialDraft: "请基于指定材料页进行分析：提炼核心概念与前置知识，解释关键公式或论证，指出不确定或无法辨认的内容。给出一道不附答案的理解检查练习，并建议后续学习顺序。使用提供的出处，不要把你的判断当成我已掌握的证据。" };
}
