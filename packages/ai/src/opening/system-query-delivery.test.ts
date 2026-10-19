import { describe, expect, it } from "vitest";
import { providerInputSchema, type SystemQueryReceipt } from "@aistudy/contracts";
import { validateSystemQueryDelivery } from "./system-query-delivery";
import { renderSystemQuery, fallbackSystemQuery, SYSTEM_QUERY_TOOLS } from "./system-query-agent";
import { evaluateStudyRetrieval } from "./system-query-retrieval-eval";
const id = "00000000-0000-4000-8000-000000000001", asOf = "2026-10-19T00:00:00.000Z";
const authorization = { purpose: "system_record_lookup" as const, workspaceId: id, principalId: id, role: "workspace_owner" as const, permissionRevision: "v1" };
function receipt(): SystemQueryReceipt { return { authorization, version: "study-query-v1", asOf, privacyEpoch: 0, mode: "deterministic", status: "ok", reason: "read", results: [{ authorization,
  name: "courses", status: "ok", reason: "read", asOf, version: "v1", sourceRefs: [], evidence: [], nextOffset: null,
  data: [{ id, title: "数学", updatedAt: asOf, goal: null, goalStatus: "not_configured", summary: "已保存数学课程" }] }] }; }
describe("system query delivery", () => {
  it("accepts the full registered read-tool set at the actual provider input boundary", () => {
    expect(SYSTEM_QUERY_TOOLS).toHaveLength(13);
    expect(providerInputSchema.safeParse({ instruction: "read only", text: "学习状态", mode: "listen", chunks: [], maxOutputTokens: 1000,
      mediaCapability: "text_only", imageParts: [], tools: SYSTEM_QUERY_TOOLS }).success).toBe(true);
  });
  it("withholds future records and all associated lineage on a mixed time receipt", () => {
    const raw = receipt(); raw.results[0]!.asOf = "2026-10-20T00:00:00.000Z";
    expect(validateSystemQueryDelivery(raw)).toMatchObject({ status: "unknown", results: [{ status: "unknown", reason: "stale", data: [], evidence: [], sourceRefs: [] }] });
    expect(renderSystemQuery(raw)).not.toContain("已保存数学课程");
  });
  it("renders cutoff/version/completeness, bounded interpretation and executable recovery", () => {
    const text = renderSystemQuery(receipt());
    for (const expected of ["数据截止", "版本 v1", "完整性", "解释：", "下一步：", "打开上方记录"]) expect(text).toContain(expected);
    const raw = receipt(); raw.results[0]!.status = "unknown"; raw.results[0]!.reason = "timeout"; raw.results[0]!.data = []; raw.status = "unknown";
    expect(renderSystemQuery(raw)).toContain("查询超时"); expect(renderSystemQuery(raw)).toContain("查询失败不会更改学习状态");
  });
  it("routes natural cross-domain reads to actual registered tools", () => {
    for (const [question, name] of [["我的笔记有哪些", "notes"], ["cards due", "cards"], ["考前冲刺进度", "exam_sprint"], ["学习状态", "learner_state"], [`decision ${id}`, "explain_decision"]]) {
      expect(fallbackSystemQuery(question!)[0]?.name).toBe(name);
    }
  });
  it("combines natural questions across notes, cards and accepted plans", () => {
    expect(fallbackSystemQuery("我的笔记、卡片与今天计划").map(request => request.name)).toEqual(["notes", "cards", "planning"]);
  });
  it("measures English, Chinese aliases and synonym gaps before adopting semantic retrieval", () => {
    const literal = evaluateStudyRetrieval("literal"), curated = evaluateStudyRetrieval("curated_alias");
    expect(literal.hits).toBe(6); expect(curated.hits).toBe(9);
    expect(literal.cases.filter(test => test.group === "english").every(test => test.hit)).toBe(true);
    expect(literal.cases.filter(test => test.group === "chinese_alias").every(test => test.hit)).toBe(true);
    expect(literal.cases.filter(test => test.group === "synonym").some(test => !test.hit)).toBe(true);
  });
});
