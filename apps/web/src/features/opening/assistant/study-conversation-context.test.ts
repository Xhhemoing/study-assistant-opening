import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { parseStudyConversationContext, pinnedStudySourceProblem, questionWithStudyContext, studyContextReturnHref, studyConversationHref, studyConversationIdentity, type StudyConversationContext } from "./study-conversation-context";
const id = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const context: StudyConversationContext = { courseId: id, activityId: id, blockId: id, contentVersion: 2, sourceId, sourceVersion: 0, page: 3, chunkId: id, fragment: "矩阵改变向量的方向", label: "矩阵与向量", returnTo: `/opening/courses/${id}/study?activity=${id}&block=${id}` };

describe("study conversation entry", () => {
  it("round-trips exact course, unit, content version, material version and selected fragment", () => {
    const query = Object.fromEntries(new URL(studyConversationHref(context), "https://study.example").searchParams);
    expect(parseStudyConversationContext(query)).toEqual({ context, error: null });
  });
  it("accepts a source-only entry without manufacturing a course or page", () => {
    expect(parseStudyConversationContext({ source: sourceId, version: "0" })).toEqual({ context: { sourceId, sourceVersion: 0 }, error: null });
    expect(parseStudyConversationContext({})).toEqual({ context: null, error: null });
  });
  it.each([
    { source: "bad" }, { source: sourceId, version: "-1" }, { source: sourceId, version: "bad" }, { source: sourceId, version: "" },
    { source: sourceId, page: "0" }, { version: "2" }, { blockId: id }, { activityId: id, contentVersion: "-1" },
    { returnTo: "https://external.example" }, { returnTo: "//external.example/opening/library" },
    { source: sourceId, fragment: "x".repeat(4001) },
  ])("rejects malformed or unsafe context instead of silently changing its meaning: %j", query => {
    expect(parseStudyConversationContext(query).error).toContain("停止发送");
  });
  it("scopes question drafts by exact unit, content version, pinned material and selected text", () => {
    expect(studyConversationIdentity(context)).not.toBe(studyConversationIdentity({ ...context, courseId: sourceId }));
    expect(studyConversationIdentity(context)).not.toBe(studyConversationIdentity({ ...context, contentVersion: 3 }));
    expect(studyConversationIdentity(context)).not.toBe(studyConversationIdentity({ ...context, sourceVersion: 1 }));
    expect(studyConversationIdentity(context)).not.toBe(studyConversationIdentity({ ...context, fragment: "另一个片段" }));
  });
  it("marks carried content as question background rather than authoritative evidence", () => {
    const text = questionWithStudyContext("为什么？", context);
    expect(text).toContain(context.fragment);
    expect(text).toContain("尚未作为资料证据核验");
    expect(text).toContain("我的问题：\n为什么？");
    expect(text).not.toContain(id);
    expect(questionWithStudyContext(text, context)).toBe(text);
    expect(questionWithStudyContext("自由提问")).toBe("自由提问");
  });
  it("blocks fixed old versions and inaccessible material while preserving a pinned reading return", () => {
    const source = { id: sourceId, version: 0, uploadState: "uploaded" } as SourceRecord;
    expect(pinnedStudySourceProblem(context, [source])).toBeNull();
    expect(pinnedStudySourceProblem(context, [{ ...source, version: 1 }])).toContain("避免改用新版");
    expect(pinnedStudySourceProblem(context, [])).toContain("问题已保留");
    expect(studyContextReturnHref({ sourceId, sourceVersion: 0, page: 3 })).toContain(`source=${sourceId}&version=0&page=3`);
    expect(studyContextReturnHref(context)).toBe(context.returnTo);
    expect(studyContextReturnHref({ ...context, returnTo: "https://evil.example" })).toContain("/opening/library?");
  });
});
