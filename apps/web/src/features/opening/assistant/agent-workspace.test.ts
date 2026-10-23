import { describe, expect, it } from "vitest";
import type { ConversationSummary, SystemQueryReceipt } from "@aistudy/contracts";
import { filterConversations } from "./agent-workspace";
import { querySteps } from "./query-evidence-links";

const row = (id: string, title: string, updatedAt: string, lastTurnPreview: string | null = null): ConversationSummary => ({ id, title, courseId: null, updatedAt, lastTurnPreview });

describe("agent conversation rail", () => {
  it("sorts newest first and filters by title or last turn", () => {
    const rows = [row("a", "线代复习", "2026-10-20T00:00:00.000Z"), row("b", "概率", "2026-10-22T00:00:00.000Z", "条件概率怎么算")];
    expect(filterConversations(rows, "").map(item => item.id)).toEqual(["b", "a"]);
    expect(filterConversations(rows, "线代").map(item => item.id)).toEqual(["a"]);
    expect(filterConversations(rows, "条件").map(item => item.id)).toEqual(["b"]);
  });
});

describe("agent query steps", () => {
  it("labels what the assistant read before answering, from the receipt only", () => {
    const result = (name: string, status: string, reason: string, data: unknown[]) => ({ name, status, reason, data });
    const receipt = { results: [result("learning", "ok", "read", [{}, {}, {}]), result("planning", "ok", "no_data", []), result("materials", "partial", "timeout", [])] } as unknown as SystemQueryReceipt;
    expect(querySteps(receipt)).toEqual([
      { name: "learning", label: "学习记录", outcome: "3 条", ok: true },
      { name: "planning", label: "学习计划", outcome: "没有记录", ok: true },
      { name: "materials", label: "资料", outcome: "超时", ok: false },
    ]);
    expect(querySteps(null)).toEqual([]);
  });
});
