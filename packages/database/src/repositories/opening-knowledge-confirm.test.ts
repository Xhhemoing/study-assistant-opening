import type { Sql } from "postgres";
import type { KnowledgeSnapshot } from "@aistudy/contracts";
import { knowledgeNodeDefinition } from "@aistudy/domain";
import { describe, expect, it } from "vitest";
import { createOpeningKnowledgeRepository } from "./opening-knowledge";

// Unit scope: transaction flow, branch decisions and which statements run with which ids.
// The WHERE conditions themselves (workspace, owner, archived course, course membership,
// source availability, privacy exclusion) are exercised against PostgreSQL in
// tests/integration/opening-knowledge*.test.ts and tests/integration/handler/.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) }, courseId = id(3), nodeId = id(4), sourceId = id(5), chunkId = id(6);
const sourceVersions = { [sourceId]: 1 };

function fixture(options: { owner?: boolean; status?: "needs_check" | "supported" | "suggested"; liveVersion?: number; failAudit?: boolean;
  evidence?: string[]; } = {}) {
  let state: { version: number; snapshot: KnowledgeSnapshot; source_versions: Record<string, number> } = {
    version: 1, source_versions: sourceVersions,
    snapshot: { courseId, version: 1, nodes: [{ id: nodeId, courseId, label: "函数", kind: "concept", status: options.status ?? "needs_check",
      evidenceChunkIds: options.evidence ?? [chunkId] }], edges: [] },
  };
  let audits: unknown[][] = [], inTransaction = false;
  const chunkQueries: unknown[][] = [];
  const chunk = { id: chunkId, source_id: sourceId, source_version: 1, text: "定义", page: 1,
    slide_label: null, start_ms: null, end_ms: null, image_object_key: null };
  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings, "raw")) return strings;
    expect(inTransaction).toBe(true);
    const query = strings.join("?");
    if (query.includes("FROM workspaces")) return Promise.resolve(options.owner === false ? [] : [{ id: scope.workspaceId }]);
    if (query.includes("SELECT version,snapshot")) return Promise.resolve([state]);
    if (query.includes("SELECT s.id,s.version")) return Promise.resolve([{ id: sourceId, version: options.liveVersion ?? 1 }]);
    if (query.includes("SELECT c.*")) { chunkQueries.push(values); return Promise.resolve([chunk]); }
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
  return { repo: createOpeningKnowledgeRepository(sql), state: () => state, audits: () => audits, chunkQueries };
}

type Node = KnowledgeSnapshot["nodes"][number];
const chunkRow = (chunk: string, version = 1) => ({ id: chunk, source_id: sourceId, source_version: version,
  page: 1, slide_label: null, start_ms: null, end_ms: null, text: "定义", image_object_key: null });
/** replace() against a stored v2 graph; records confirmation DELETE statements and their values. */
function replaceFixture(old: KnowledgeSnapshot, options: { chunks?: ReturnType<typeof chunkRow>[]; confirmation?: Record<string, unknown> } = {}) {
  const chunks = options.chunks ?? [chunkRow(chunkId)];
  const definitions = Object.fromEntries(old.nodes.map(node => [node.id, knowledgeNodeDefinition(node,
    chunks.map(row => ({ id: row.id, sourceId, sourceVersion: row.source_version, text: row.text, page: 1,
      slideLabel: null, startMs: null, endMs: null, imageObjectKey: null })))]));
  const deletes: Array<{ query: string; values: unknown[] }> = [];
  const updates: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings, "raw")) return strings;
    const query = strings.join("?");
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId }]);
    if (query.includes("SELECT version, snapshot")) return Promise.resolve([{ version: 2, snapshot: old,
      source_versions: sourceVersions, node_definitions: definitions }]);
    if (query.includes("SELECT c.*")) return Promise.resolve(chunks);
    if (query.includes("FROM opening_skill_evidence")) return Promise.resolve([]);
    if (query.includes("SELECT workspace_id, course_id")) return Promise.resolve([{ workspace_id: scope.workspaceId,
      course_id: courseId, version: 2, snapshot: old, source_versions: sourceVersions }]);
    if (query.includes("UPDATE opening_course_knowledge")) { updates.push(values); return Promise.resolve([]); }
    if (query.includes("SELECT DISTINCT ON (node_id)")) return Promise.resolve([options.confirmation ?? { node_id: nodeId,
      source_versions: sourceVersions, evidence_chunk_ids: [chunkId], node_label: "函数", node_kind: "concept" }]);
    if (query.includes("INSERT INTO opening_course_knowledge")) return Promise.resolve([{ version: values[3], snapshot: values[4], source_versions: values[5] }]);
    if (query.includes("DELETE FROM opening_knowledge_confirmations")) { deletes.push({ query, values }); return Promise.resolve([]); }
    throw new Error(`unexpected query: ${query}`);
  }) as unknown as Sql;
  sql.json = (value => value) as Sql["json"];
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  return { repo: createOpeningKnowledgeRepository(sql), deletes, updates };
}
const graph = (nodes: Node[]): KnowledgeSnapshot => ({ courseId, version: 2, nodes, edges: [] });
const node = (overrides: Partial<Node> = {}): Node => ({ id: nodeId, courseId, label: "函数", kind: "concept",
  evidenceChunkIds: [chunkId], status: "supported", ...overrides });
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
  it.each((["needs_check", "suggested"] as const).flatMap(status =>
    ["same", "version", "evidence", "different-node", "label"].map(change => ({ status, change }))))(
    "rebuild applies only exact confirmed provenance: $status / $change", async ({ status, change }) => {
    const old: KnowledgeSnapshot = { courseId, version: 2, nodes: [{ id: nodeId, courseId, label: "函数", kind: "concept",
      evidenceChunkIds: [chunkId], status: "supported" }], edges: [] };
    const draft = structuredClone(old); draft.nodes[0]!.status = status;
    if (change === "evidence") draft.nodes[0]!.evidenceChunkIds = [id(7)];
    if (change === "different-node") draft.nodes[0]!.id = id(8);
    const chunk = { id: draft.nodes[0]!.evidenceChunkIds[0]!, sourceId, sourceVersion: change === "version" ? 2 : 1,
      text: "定义", page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null };
    const versions = { [sourceId]: chunk.sourceVersion };
    const definition = knowledgeNodeDefinition(old.nodes[0]!, [{ ...chunk, id: chunkId }]);
    const deletes: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
      if (!Object.hasOwn(strings, "raw")) return strings;
      const query = strings.join("?");
      if (query.includes("FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId }]);
      if (query.includes("SELECT version, snapshot")) return Promise.resolve([{ version: 2, snapshot: old,
        source_versions: sourceVersions, node_definitions: { [nodeId]: definition } }]);
      if (query.includes("SELECT c.*")) return Promise.resolve([{ id: chunk.id, source_id: sourceId, source_version: chunk.sourceVersion,
        page: 1, slide_label: null, start_ms: null, end_ms: null, text: "定义", image_object_key: null }]);
      if (query.includes("FROM opening_skill_evidence")) return Promise.resolve([]);
      if (query.includes("DELETE FROM opening_knowledge_confirmations")) { deletes.push(values); return Promise.resolve([]); }
      if (query.includes("FROM opening_knowledge_confirmations")) return Promise.resolve([{ node_id: nodeId,
        source_versions: sourceVersions, evidence_chunk_ids: [chunkId], node_label: change === "label" ? "旧标签" : "函数", node_kind: "concept" }]);
      if (query.includes("INSERT INTO opening_course_knowledge")) return Promise.resolve([{ version: values[3], snapshot: values[4], source_versions: values[5] }]);
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as Sql;
    sql.json = (value => value) as Sql["json"];
    sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
    const result = await createOpeningKnowledgeRepository(sql).replace(scope, courseId,
      { expectedVersion: 2, expectedReferencedNodeIds: [], snapshot: draft, sourceVersions: versions });
    // A new UUID has no confirmation to inherit: retain its worker classification, never
    // elevate it using the retired node's receipt. Changed provenance of the same UUID is pending.
    expect(result.snapshot.nodes[0]!.status).toBe(change === "same" ? "supported"
      : change === "different-node" ? status : "needs_check");
    expect(result.snapshot.nodes[0]!.id).toBe(draft.nodes[0]!.id);
    expect(result.snapshot.nodes[0]!.evidenceChunkIds).toEqual(draft.nodes[0]!.evidenceChunkIds);
    expect(result.sourceVersions).toEqual(versions);
    // A changed graph/source/identity invalidates the receipt permanently, not just this rebuild.
    expect(deletes).toEqual(change !== "same" ? [[scope.workspaceId, scope.ownerUserId, courseId, [nodeId]]] : []);
  });
  it.each([
    ["manual supported -> needs_check", undefined, "needs_check", [nodeId]],
    ["manual supported -> suggested", undefined, "suggested", [nodeId]],
    ["manual supported unchanged", undefined, "supported", []],
    ["worker reclassifies to needs_check", [] as string[], "needs_check", []],
    ["worker reclassifies to suggested", [] as string[], "suggested", []],
  ] as const)("withdraws confirmations only when the node is removed or manually moved off supported: %s", async (_name, refs, status, expected) => {
    const f = replaceFixture(graph([node()]));
    const result = await f.repo.replace(scope, courseId, { expectedVersion: 2, expectedReferencedNodeIds: refs,
      snapshot: graph([node({ status })]), sourceVersions });
    expect(result.snapshot.nodes[0]!.status).toBe(refs ? "supported" : status);
    expect(f.deletes.map(item => item.values)).toEqual(expected.length ? [[scope.workspaceId, scope.ownerUserId, courseId, expected]] : []);
  });
  it("deletes a removed node's confirmation inside the replace transaction, scoped to workspace/owner/course", async () => {
    const other = id(9);
    const f = replaceFixture(graph([node(), node({ id: other, label: "映射", status: "needs_check" })]));
    await f.repo.replace(scope, courseId, { expectedVersion: 2, snapshot: graph([node({ id: other, label: "映射", status: "needs_check" })]), sourceVersions });
    expect(f.deletes).toHaveLength(1);
    expect(f.deletes[0]!.query).toMatch(/workspace_id=\?\s+AND owner_user_id=\? AND course_id=\? AND node_id IN \?/);
    expect(f.deletes[0]!.values).toEqual([scope.workspaceId, scope.ownerUserId, courseId, [nodeId]]);
  });
  it("revokes a residual receipt even when the manual graph is already needs_check", async () => {
    const f = replaceFixture(graph([node({ status: "needs_check" })]));
    const result = await f.repo.replace(scope, courseId, { expectedVersion: 2, snapshot: graph([node({ status: "needs_check" })]), sourceVersions });
    expect(result.snapshot.nodes[0]!.status).toBe("needs_check");
    expect(f.deletes.map(item => item.values)).toEqual([[scope.workspaceId, scope.ownerUserId, courseId, [nodeId]]]);
  });
  it.each(["other-node", "edge", "source-set"] as const)("revokes confirmation on whole graph/context change: %s", async change => {
    const old = graph([node(), node({ id: id(9), label: "映射", status: "needs_check" })]);
    const f = replaceFixture(old);
    const draft = structuredClone(old);
    if (change === "other-node") draft.nodes.pop();
    if (change === "edge") draft.edges.push({ from: nodeId, to: id(9), kind: "prerequisite", status: "supported", evidenceChunkIds: [chunkId] });
    const versions = change === "source-set" ? { [sourceId]: 2 } : sourceVersions;
    const replacement = change === "source-set" ? replaceFixture(old, { chunks: [chunkRow(chunkId, 2)] }) : f;
    const result = await replacement.repo.replace(scope, courseId, { expectedVersion: 2, expectedReferencedNodeIds: [],
      snapshot: draft, sourceVersions: versions });
    expect(result.snapshot.nodes[0]!.status).toBe("needs_check");
    expect(replacement.deletes.map(item => item.values)).toEqual([[scope.workspaceId, scope.ownerUserId, courseId, [nodeId]]]);
  });
  it.each(["supported", "needs_check"] as const)("source maintenance revokes receipts even from %s graphs", async status => {
    const f = replaceFixture(graph([node({ status })]));
    const result = await f.repo.markNeedsCheckForSources(scope, [sourceId]);
    expect(result).toEqual({ updated: status === "supported" ? 1 : 0, courseIds: [courseId] });
    expect(f.deletes.map(item => item.values)).toEqual([[scope.workspaceId, scope.ownerUserId, courseId]]);
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]![0]).toBe(3);
    expect(f.updates[0]![1]).toMatchObject({ version: 3, nodes: [{ status: "needs_check" }] });
  });
  it("rejects a same-looking pending graph's stale CAS instead of treating maintenance as replace replay", async () => {
    const old = graph([node({ status: "needs_check" })]);
    const f = replaceFixture(old);
    await expect(f.repo.replace(scope, courseId, { expectedVersion: 1, expectedReferencedNodeIds: [],
      snapshot: structuredClone(old), sourceVersions })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.deletes).toEqual([]);
    expect(f.updates).toEqual([]);
  });
  it("does not delete on a stale-version conflict", async () => {
    const f = replaceFixture(graph([node()]));
    await expect(f.repo.replace(scope, courseId, { expectedVersion: 1, snapshot: graph([]), sourceVersions: {} }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.deletes).toEqual([]);
  });
  it("confirms a node whose evidence lists the same chunk twice, using the unique sorted set", async () => {
    const f = fixture({ evidence: [chunkId, chunkId] });
    const result = await f.repo.confirmNode(scope, courseId, nodeId, input);
    expect(result.snapshot.nodes[0]!.status).toBe("supported");
    // Both the evidence read and assertAuthorizedChunks receive the de-duplicated ids.
    expect(f.chunkQueries).toHaveLength(2);
    for (const values of f.chunkQueries) expect(values).toContainEqual([chunkId]);
    expect(f.audits()[0]!.slice(-2)).toEqual([sourceVersions, [chunkId]]);
  });
  it("propagates an audit failure and rolls back the graph transition", async () => {
    const f = fixture({ failAudit: true });
    await expect(f.repo.confirmNode(scope, courseId, nodeId, input)).rejects.toThrow("audit write failed");
    expect(f.state().version).toBe(1); expect(f.state().snapshot.nodes[0]!.status).toBe("needs_check");
    expect(f.audits()).toHaveLength(0);
  });
});
