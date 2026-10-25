import { z } from "zod";
import type { SourceRecord, StudyContextAnchor } from "@aistudy/contracts";
import { sourceViewerHref } from "../inbox/source-viewer";

export type StudyConversationContext = {
  courseId?: string;
  activityId?: string;
  attemptId?: string;
  itemVersionId?: string;
  kcMappingVersion?: number;
  purpose?: StudyContextAnchor["purpose"];
  blockId?: string;
  contentVersion?: number;
  sourceId?: string;
  sourceVersion?: number;
  page?: number;
  chunkId?: string;
  fragment?: string;
  label?: string;
  returnTo?: string;
};
export type StudyConversationQuery = Partial<Record<"courseId" | "activityId" | "attemptId" | "itemVersionId" | "kcMappingVersion" | "purpose" | "blockId" | "contentVersion" | "source" | "version" | "page" | "chunkId" | "fragment" | "label" | "returnTo", string>>;

function allowedReturn(value: string): boolean {
  if (!value.startsWith("/opening/") || value.includes("\\")) return false;
  try {
    const url = new URL(value, "https://study.invalid");
    return url.origin === "https://study.invalid" && (["/opening/library", "/opening/cards", "/opening/review", "/opening/today", "/opening/sprint"].includes(url.pathname) || /^\/opening\/courses\/[0-9a-f-]{36}(?:\/study(?:\/span|\/matrix)?)?$/.test(url.pathname));
  } catch { return false; }
}
const integerQuery = z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).pipe(z.number().int().nonnegative());
const contextSchema = z.object({
  courseId: z.string().uuid().optional(), activityId: z.string().uuid().optional(), blockId: z.string().uuid().optional(),
  attemptId: z.string().uuid().optional(), itemVersionId: z.string().uuid().optional(),
  kcMappingVersion: integerQuery.pipe(z.number().positive()).optional(),
  purpose: z.enum(["learning_help", "language_support", "material_read", "note_read", "card_answer", "history_solution", "exam_help", "task_start"]).optional(),
  contentVersion: integerQuery.optional(), source: z.string().uuid().optional(),
  version: integerQuery.optional(), page: integerQuery.pipe(z.number().positive().max(2000)).optional(),
  chunkId: z.string().uuid().optional(), fragment: z.string().max(4000).optional(), label: z.string().max(160).optional(),
  returnTo: z.string().max(2000).refine(allowedReturn).optional(),
}).superRefine((value, ctx) => {
  if ((value.version !== undefined || value.page !== undefined || value.chunkId) && !value.source) ctx.addIssue({ code: "custom", message: "材料定位缺少材料身份" });
  if ((value.blockId || value.contentVersion !== undefined) && !value.activityId) ctx.addIssue({ code: "custom", message: "学习单元定位缺少活动身份" });
});

export function parseStudyConversationContext(query: StudyConversationQuery): { context: StudyConversationContext | null; error: string | null } {
  if (!Object.values(query).some(value => value !== undefined)) return { context: null, error: null };
  const parsed = contextSchema.safeParse(query);
  if (!parsed.success) return { context: null, error: "提问背景的身份、版本或位置无效，已停止发送；请返回原内容重新打开提问。" };
  const { source, version, ...rest } = parsed.data;
  return { context: { ...rest, ...(source ? { sourceId: source } : {}), ...(version !== undefined ? { sourceVersion: version } : {}) }, error: null };
}

export function studyConversationHref(context: StudyConversationContext): string {
  const params = new URLSearchParams();
  const { sourceId, sourceVersion, ...rest } = context;
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) params.set(key, String(value));
  if (sourceId) params.set("source", sourceId);
  if (sourceVersion !== undefined) params.set("version", String(sourceVersion));
  return `/opening/assistant?${params}`;
}

export function legacyStudyConversationIdentity(context?: StudyConversationContext | null): string {
  return JSON.stringify([context?.courseId, context?.activityId, context?.blockId, context?.contentVersion,
    context?.sourceId, context?.sourceVersion, context?.page, context?.chunkId, context?.fragment]);
}
export function studyConversationIdentity(context?: StudyConversationContext | null): string {
  const legacy = legacyStudyConversationIdentity(context);
  // Existing drafts and unknown note-create receipts keep their original key.
  if (!context?.attemptId && !context?.itemVersionId && context?.kcMappingVersion === undefined) return legacy;
  return JSON.stringify([...JSON.parse(legacy) as unknown[], context?.attemptId, context?.itemVersionId, context?.kcMappingVersion]);
}

export function studyContextReturnHref(context?: StudyConversationContext): string | null {
  if (!context) return null;
  if (context.returnTo && allowedReturn(context.returnTo)) return context.returnTo;
  if (context.sourceId && context.sourceVersion !== undefined) return sourceViewerHref(context.sourceId, context.sourceVersion, { page: context.page });
  if (context.courseId) {
    if (!context.activityId) return `/opening/courses/${context.courseId}`;
    const query = new URLSearchParams();
    if (context.activityId) query.set("activity", context.activityId);
    if (context.blockId) query.set("block", context.blockId);
    if (context.contentVersion !== undefined) query.set("contentVersion", String(context.contentVersion));
    return `/opening/courses/${context.courseId}/study${query.size ? `?${query}` : ""}`;
  }
  return null;
}

/** This is user-carried background text, never an authoritative citation or mastery record. */
export function questionWithStudyContext(question: string, context?: StudyConversationContext): string {
  if (!context || !(context.activityId || context.fragment)) return question;
  const label = context.label?.trim() || "当前学习内容";
  const prefix = `【从学习界面带入的提问背景；尚未作为资料证据核验，也不表示我已掌握】\n${label}${context.fragment ? `\n选中片段：\n${context.fragment}` : ""}\n\n我的问题：\n`;
  return question.startsWith(prefix) ? question : `${prefix}${question}`;
}

export function pinnedStudySourceProblem(context: StudyConversationContext | undefined, sources: readonly SourceRecord[]): string | null {
  if (!context?.sourceId || context.sourceVersion === undefined) return null;
  const source = sources.find(item => item.id === context.sourceId);
  if (!source || source.uploadState !== "uploaded") return "指定材料暂不可用于提问。原阅读位置和未发送问题已保留，请返回材料核对。";
  if (source.version !== context.sourceVersion) return "当前打开的是固定版本材料。对话服务暂不能锁定历史版本，已停止发送，避免改用新版；仍可返回阅读。";
  return null;
}

/** Structured identity is checked by the server; selected text remains untrusted background. */
export function studyContextAnchor(context?: StudyConversationContext, attempt?: { id: string; itemVersionId?: string | null; courseId?: string }): StudyContextAnchor | undefined {
  if (!context && !attempt) return undefined;
  const { courseId, activityId, blockId, contentVersion, sourceId, sourceVersion, page, chunkId, kcMappingVersion } = context ?? {};
  return { ...(courseId || attempt?.courseId ? { courseId: courseId ?? attempt?.courseId } : {}),
    ...(activityId ? { activityId } : {}), ...(blockId ? { blockId } : {}),
    ...(contentVersion !== undefined ? { contentVersion } : {}), ...(sourceId ? { sourceId } : {}),
    ...(sourceVersion !== undefined ? { sourceVersion } : {}), ...(page !== undefined ? { page } : {}),
    ...(chunkId ? { chunkId } : {}), ...(kcMappingVersion !== undefined ? { kcMappingVersion } : {}),
    ...(context?.attemptId || attempt?.id ? { attemptId: context?.attemptId ?? attempt?.id } : {}),
    ...(context?.itemVersionId || attempt?.itemVersionId ? { itemVersionId: context?.itemVersionId ?? attempt?.itemVersionId } : {}),
    purpose: context?.purpose ?? "learning_help" };
}
