import { describe, expect, it, vi } from "vitest";
import { createOpeningApi } from "../client/api";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const courseId = id(1), nodeId = id(2);
const input = { nodeId, expectedVersion: 3, sourceVersions: { [id(4)]: 7 } };

describe("knowledge confirmation client boundary", () => {
  it("posts pinned versions and validates the returned graph", async () => {
    const result = { version: 4, sourceVersions: input.sourceVersions, snapshot: { courseId, version: 4,
      nodes: [{ id: nodeId, courseId, label: "函数", kind: "concept", status: "supported", evidenceChunkIds: [id(5)] }], edges: [] } };
    const fetchImpl = vi.fn(async () => Response.json(result));
    await expect(createOpeningApi(fetchImpl).confirmKnowledgeNode(courseId, input)).resolves.toEqual(result);
    expect(fetchImpl).toHaveBeenCalledWith(`/api/opening/courses/${courseId}/knowledge/confirm`, expect.objectContaining({
      method: "POST", body: JSON.stringify(input),
    }));
  });
  it("preserves conflicts and never automatically retries a confirmation", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { code: "CONFLICT", message: "材料已变化，请重新核对。" } }, { status: 409 }));
    await expect(createOpeningApi(fetchImpl).confirmKnowledgeNode(courseId, input)).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects a malformed success", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ version: 4, snapshot: {}, sourceVersions: {} }));
    await expect(createOpeningApi(fetchImpl).confirmKnowledgeNode(courseId, input)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not retry a 503", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { code: "UNAVAILABLE", message: "服务暂不可用" } }, { status: 503 }));
    await expect(createOpeningApi(fetchImpl).confirmKnowledgeNode(courseId, input)).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not retry a network failure", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => { throw new TypeError("Failed to fetch"); });
    await expect(createOpeningApi(fetchImpl).confirmKnowledgeNode(courseId, input)).rejects.toBeInstanceOf(TypeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
