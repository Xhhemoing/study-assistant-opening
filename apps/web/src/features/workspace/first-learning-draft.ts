import { z } from "zod";
import { uuidSchema } from "@aistudy/contracts";
import { firstLearningInputSchema } from "./first-learning-input";

const draftSchema = z.object({
  clientKey: uuidSchema, topic: z.string().max(120), goal: z.string().max(1000), targetDate: z.string().max(10),
  minutes: z.number().finite(), startTime: z.string().max(5), timeZone: z.string().max(80),
  sourceIds: z.array(uuidSchema).max(32),
}).strict();
export type FirstLearningDraft = z.infer<typeof draftSchema>;
export function emptyFirstLearningDraft(clientKey: string, timeZone: string): FirstLearningDraft {
  return { clientKey, topic: "", goal: "", targetDate: "", minutes: 30, startTime: "19:00", timeZone, sourceIds: [] };
}
export function readFirstLearningDraft(storage: Pick<Storage, "getItem">, key: string): FirstLearningDraft | null {
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > 16_384) return null;
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; } // Optional browser storage may be unavailable.
}
export function saveFirstLearningDraft(storage: Pick<Storage, "setItem">, key: string, draft: FirstLearningDraft) {
  try { storage.setItem(key, JSON.stringify(draft)); } catch { /* The form remains usable without optional storage. */ }
}
const resultSchema = z.object({ activityId: uuidSchema, taskId: uuidSchema, href: z.literal("/opening/today") });
export async function submitFirstLearningDraft(draft: FirstLearningDraft, fetcher: typeof fetch = fetch) {
  const input = firstLearningInputSchema.parse({ ...draft, targetDate: draft.targetDate || null });
  let response: Response;
  try {
    response = await fetcher("/api/opening/first-learning", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
  } catch {
    throw new Error("网络中断，未能确认保存结果；请先查看今日页，也可保留原内容继续同一次请求。修改内容会创建新的学习意图。");
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error("登录已过期，请重新登录；当前标签页中的学习意图仍保留。");
    if (response.status === 400) throw new Error("请检查学习主题、目标日期、每日时间和所选材料。");
    if (response.status === 404) throw new Error("所选材料已不可用，请重新选择材料后开始。");
    if (response.status === 409) throw new Error("学习意图或设置已变化，请先查看今日页和学习时间设置，再继续。");
    throw new Error("未能确认全部设置结果；请先查看今日页，也可以保留原内容继续同一次请求。");
  }
  try { return resultSchema.parse(await response.json()); } catch {
    throw new Error("服务器未返回完整确认，内容可能已保存；请查看今日页后保留原内容继续。");
  }
}
