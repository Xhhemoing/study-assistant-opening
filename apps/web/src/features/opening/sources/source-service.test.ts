import { describe, expect, it, beforeEach } from "vitest";
import {
  clearOpeningSourceStagingForTests,
  createOpeningSourceService,
} from "./source-service";
import type { Principal } from "../../../lib/authorization";

const W = "00000000-0000-4000-8000-000000000001";
const U = "00000000-0000-4000-8000-0000000000aa";
const S = "00000000-0000-4000-8000-000000000003";
const SHA = "a".repeat(64);
const principal: Principal = { userId: U, workspaceId: W, sessionId: "sess" };

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: S,
    workspace_id: W,
    name: "a.pdf",
    mime: "application/pdf",
    bytes: 12,
    sha256: SHA,
    version: 0,
    upload_state: "pending",
    parse_state: "not_started",
    error: null,
    created_at: new Date("2026-09-13T00:00:00.000Z"),
    updated_at: new Date("2026-09-13T00:00:00.000Z"),
    ...overrides,
  };
}

describe("opening source HTTP service (no real S3)", () => {
  beforeEach(() => clearOpeningSourceStagingForTests());

  it("begin → stage → complete yields uploaded SourceRecord without courseId", async () => {
    let state = "pending";
    const _sql = async (parts: TemplateStringsArray) => {
      const q = parts.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("INSERT INTO opening_sources")) return [pendingRow()];
      if (q.startsWith("SELECT * FROM opening_sources")) {
        return [pendingRow({ upload_state: state })];
      }
      if (q.startsWith("UPDATE opening_sources")) {
        state = "uploaded";
        return [pendingRow({ upload_state: "uploaded" })];
      }
      if (q.startsWith("SELECT * FROM opening_sources") === false && q.includes("WHERE workspace_id")) {
        return [];
      }
      throw new Error("unexpected sql: " + q);
    };
    // list uses ORDER BY query
    const sql2 = async (parts: TemplateStringsArray) => {
      const q = parts.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("INSERT INTO opening_sources")) return [pendingRow()];
      if (q.startsWith("SELECT * FROM opening_sources WHERE id")) {
        return [pendingRow({ upload_state: state })];
      }
      if (q.startsWith("SELECT * FROM opening_sources WHERE workspace_id")) {
        return state === "uploaded"
          ? [pendingRow({ upload_state: "uploaded" })]
          : [pendingRow()];
      }
      if (q.startsWith("UPDATE opening_sources")) {
        state = "uploaded";
        return [pendingRow({ upload_state: "uploaded" })];
      }
      throw new Error("unexpected sql: " + q);
    };

    const svc = createOpeningSourceService(sql2 as never);
    const ticket = await svc.beginUpload(
      principal,
      { name: "a.pdf", mime: "application/pdf", bytes: 12, sha256: SHA },
      "http://127.0.0.1/api/opening/sources/__SOURCE_ID__/staging",
    );
    expect(ticket.uploadUrl).toContain(ticket.source.id);
    expect(ticket.source).not.toHaveProperty("courseId");
    expect(ticket.source.uploadState).toBe("pending");

    const bytes = new Uint8Array(12);
    // Force sha256 of empty-ish buffer to match by using exact SHA of these bytes
    const { createHash } = await import("node:crypto");
    const realSha = createHash("sha256").update(bytes).digest("hex");
    // recreate with matching sha in DB row — override via custom sql
    const rowSha = realSha;
    let rowState = "pending";
    const sql3 = async (parts: TemplateStringsArray) => {
      const q = parts.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("INSERT INTO opening_sources")) {
        return [pendingRow({ sha256: rowSha })];
      }
      if (q.startsWith("SELECT * FROM opening_sources WHERE id")) {
        return [pendingRow({ sha256: rowSha, upload_state: rowState })];
      }
      if (q.startsWith("SELECT * FROM opening_sources WHERE workspace_id")) {
        return [pendingRow({ sha256: rowSha, upload_state: rowState })];
      }
      if (q.startsWith("UPDATE opening_sources")) {
        rowState = "uploaded";
        return [pendingRow({ sha256: rowSha, upload_state: "uploaded" })];
      }
      throw new Error("unexpected sql: " + q);
    };
    clearOpeningSourceStagingForTests();
    const svc3 = createOpeningSourceService(sql3 as never);
    const ticket3 = await svc3.beginUpload(
      principal,
      { name: "a.pdf", mime: "application/pdf", bytes: 12, sha256: realSha },
      "http://127.0.0.1/api/opening/sources/__SOURCE_ID__/staging",
    );
    await svc3.putStaging(principal, ticket3.source.id, bytes, "application/pdf");
    const done = await svc3.completeUpload(principal, ticket3.source.id);
    expect(done.uploadState).toBe("uploaded");
    expect(done).not.toHaveProperty("courseId");

    const listed = await svc3.listSources(principal);
    expect(listed[0]?.uploadState).toBe("uploaded");
  });

  it("complete without staging fails policy", async () => {
    const sql = async (parts: TemplateStringsArray) => {
      const q = parts.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("SELECT * FROM opening_sources")) return [pendingRow()];
      throw new Error("unexpected sql: " + q);
    };
    const svc = createOpeningSourceService(sql as never);
    await expect(svc.completeUpload(principal, S)).rejects.toThrow(/staged object missing/);
  });
});
