import type { Sql } from "postgres";
import type { KnowledgeSnapshot } from "@aistudy/contracts";
import { knowledgeNodeDefinition } from "@aistudy/domain";
import { describe, expect, it } from "vitest";
import { createOpeningKnowledgeRepository } from "./opening-knowledge";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) }, courseId = id(3), nodeId = id(4), sourceId = id(5), chunkId = id(6);
const sourceVersions = { [sourceId]: 1 };

function fixture(options: { owner?: boolean; status?: "needs_check" | "supported" | "suggested"; liveVersion?: number; failAudit?: boolean } = {}) {
  let state: { version: number; snapshot: KnowledgeSnapshot; source_versions: Record<string, number> } = {
    version: 1, source_versions: sourceVersions,
    snapshot: { courseId, version: 1, nodes: [{ id: nodeId, courseId, label: "函数", kind: "concept", status: options.status ?? "needs_check",
      evidenceChunkIds: [chunkId] }], edges: [] },
  };
  let audits: unknown[][] = [], inTransaction = false;
  const chunk = { id: chunkId, source_id: sourceId, source_version: 1, text: "定义", page: 1,
    slide_label: null, start_ms: null, end_ms: null, image_object_key: null };
  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings, "raw")) return strings;
    expect(inTransaction).toBe(true);
    const query = strings.join("?");
    if (query.includes("FROM workspaces")) return Promise.resolve(options.owner === false ? [] : [{ id: scope.workspaceId }]);
    if (query.includes("SELECT version,snapshot")) return Promise.resolve([state]);
    if (query.includes("SELECT s.id,s.version")) return Promise.resolve([{ id: sourceId, version: options.liveVersion ?? 1 }]);
    if (query.includes("SELECT c.*")) return Promise.resolve([chunk]);
    if (query.includes("UPDATE opening_course_knowledge")) {
      state = { ...state, version: values[0] as number, snapshot: values[1] as KnowledgeSnapshot };
      return Promise.resolve([]);
    }
    if (query.includes("INSERT INTO opening_knowledge_confirmations")) {
      if (options.failAudit) throw new Error("audit write failed");
      audits.push(values); return Promise.resolve([]);
    }
    throw new Error(`unexpected query: ${query}`);
  }) as unknown as Sql;
  sql.json = (value => value) as Sql["json"];
  sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => {
    const before = structuredClone(state), previousAudits = [...audits];
    inTransaction = true;
    try { return await callback(sql); }
    catch (error) { state = before; audits = previousAudits; throw error; }
    finally { inTransaction = false; }
  }) as Sql["begin"];
  return { repo: createOpeningKnowledgeRepository(sql), state: () => state, audits: () => audits };
}
const input = { expectedVersion: 1, sourceVersions };

describe("manual knowledge confirmation transaction (unit, no database)", () => {
  it("transitions only needs_check and records versions/evidence inside the same transaction", async () => {
    const f = fixture();
    const result = await f.repo.confirmNode(scope, courseId, nodeId, input);
    expect(result).toMatchObject({ version: 2, snapshot: { version: 2, nodes: [{ status: "supported" }] } });
    expect(f.audits()).toHaveLength(1);
    expect(f.audits()[0]!.slice(1)).toEqual([scope.workspaceId, scope.ownerUserId, courseId, nodeId, "函数", "concept", 1, 2, sourceVersions, [chunkId]]);
    await expect(f.repo.confirmNode(scope, courseId, nodeId, input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.audits()).toHaveLength(1);
  });
  it.each(["supported", "suggested"] as const)("rejects %s", async status => {
    const f = fixture({ status });
    await expect(f.repo.confirmNode(scope, courseId, nodeId, input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.audits()).toHaveLength(0);
  });
  it("rejects live source changes without a graph-version bump", async () => {
    const f = fixture({ liveVersion: 2 });
    await expect(f.repo.confirmNode(scope, courseId, nodeId, input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.state().version).toBe(1); expect(f.audits()).toHaveLength(0);
  });
  it("rejects stale graph versions and invalid input without writing", async () => {
    const f = fixture();
    await expect(f.repo.confirmNode(scope, courseId, nodeId, { ...input, expectedVersion: 0 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.repo.confirmNode(scope, courseId, nodeId, { ...input, expectedVersion: -1 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(f.repo.confirmNode(scope, courseId, id(99), input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.audits()).toHaveLength(0);
  });
  it("rejects a different observed source set", async () => {
    const f = fixture();
    await expect(f.repo.confirmNode(scope, courseId, nodeId, { ...input, sourceVersions: {} })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.audits()).toHaveLength(0);
  });
  it("rejects unowned courses before writes", async () => {
    const f = fixture({ owner: false });
    await expect(f.repo.confirmNode(scope, courseId, nodeId, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.state().version).toBe(1); expect(f.audits()).toHaveLength(0);
  });
  it.each(["same", "version", "evidence", "different-node", "label"])("rebuild applies only exact confirmed provenance: %s", async change => {
    const old: KnowledgeSnapshot = { courseId, version: 2, nodes: [{ id: nodeId, courseId, label: "函数", kind: "concept",
      evidenceChunkIds: [chunkId], status: "supported" }], edges: [] };
    const draft = structuredClone(old); draft.nodes[0]!.status = "needs_check";
    if (change === "evidence") draft.nodes[0]!.evidenceChunkIds = [id(7)];
    if (change === "different-node") draft.nodes[0]!.id = id(8);
    const chunk = { id: draft.nodes[0]!.evidenceChunkIds[0]!, sourceId, sourceVersion: change === "version" ? 2 : 1,
      text: "定义", page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null };
    const versions = { [sourceId]: chunk.sourceVersion };
    const definition = knowledgeNodeDefinition(old.nodes[0]!, [{ ...chunk, id: chunkId }]);
    const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
      if (!Object.hasOwn(strings, "raw")) return strings;
      const query = strings.join("?");
      if (query.includes("FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId }]);
      if (query.includes("SELECT version, snapshot")) return Promise.resolve([{ version: 2, snapshot: old,
        source_versions: sourceVersions, node_definitions: { [nodeId]: definition } }]);
      if (query.includes("SELECT c.*")) return Promise.resolve([{ id: chunk.id, source_id: sourceId, source_version: chunk.sourceVersion,
        page: 1, slide_label: null, start_ms: null, end_ms: null, text: "定义", image_object_key: null }]);
      if (query.includes("FROM opening_skill_evidence")) return Promise.resolve([]);
      if (query.includes("FROM opening_knowledge_confirmations")) return Promise.resolve([{ node_id: nodeId,
        source_versions: sourceVersions, evidence_chunk_ids: [chunkId], node_label: change === "label" ? "旧标签" : "函数", node_kind: "concept" }]);
      if (query.includes("INSERT INTO opening_course_knowledge")) return Promise.resolve([{ version: values[3], snapshot: values[4], source_versions: values[5] }]);
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as Sql;
    sql.json = (value => value) as Sql["json"];
    sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
    const result = await createOpeningKnowledgeRepository(sql).replace(scope, courseId,
      { expectedVersion: 2, expectedReferencedNodeIds: [], snapshot: draft, sourceVersions: versions });
    expect(result.snapshot.nodes[0]!.status).toBe(change === "same" ? "supported" : "needs_check");
    expect(result.snapshot.nodes[0]!.id).toBe(draft.nodes[0]!.id);
    expect(result.snapshot.nodes[0]!.evidenceChunkIds).toEqual(draft.nodes[0]!.evidenceChunkIds);
    expect(result.sourceVersions).toEqual(versions);
  });
  it("propagates an audit failure and rolls back the graph transition", async () => {
    const f = fixture({ failAudit: true });
    await expect(f.repo.confirmNode(scope, courseId, nodeId, input)).rejects.toThrow("audit write failed");
    expect(f.state().version).toBe(1); expect(f.state().snapshot.nodes[0]!.status).toBe("needs_check");
    expect(f.audits()).toHaveLength(0);
  });
});
