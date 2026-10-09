import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { loadRetestProposals, RetestProposals } from "./retest-proposals";
import type { ReviewApi } from "./review-service";

const id = "11111111-1111-4111-8111-111111111111";
const courseId = "22222222-2222-4222-8222-222222222222";

function api(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return {
    listCandidates: vi.fn(async () => []),
    listRetestCandidates: vi.fn(async () => [{
      id, courseId, skillLabel: "分数", prompt: "再做一遍：1+1", sourceIds: [] as string[],
      dueAt: "2026-10-10T00:00:00.000Z", accepted: false as const, kind: "task" as const,
    }]),
    listSources: vi.fn(async () => []),
    createTask: vi.fn(async () => ({ id, title: "t", minutes: 20, priority: 1, dueAt: null, status: "pending" as const })),
    acceptRetest: vi.fn(async () => ({ taskId: id, accepted: true as const, scheduled: false as const })),
    decideMemoryCandidate: vi.fn(async () => ({ id, text: "记忆" }) as never),
    discardCandidate: vi.fn(async () => ({ id, status: "discarded" as const })),
    ...overrides,
  };
}

describe("retest proposals", () => {
  it("loads only retest rows into review items", async () => {
    const client = api();
    const items = await loadRetestProposals(client);
    expect(items).toHaveLength(1);
    expect(items[0]?.ref).toEqual({ origin: "retest", kind: "retest", id });
    expect(items[0]?.proposal.kind).toBe("retest");
    expect(client.listRetestCandidates).toHaveBeenCalledOnce();
  });

  it("starts as a loading status before proposals arrive", () => {
    const html = renderToStaticMarkup(createElement(RetestProposals, { api: api() }));
    expect(html).toContain("正在读取补测提议");
    expect(html).toContain('role="status"');
  });
});
