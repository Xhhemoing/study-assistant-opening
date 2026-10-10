import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { collectMaterials, materialStatus } from "./material-collection";

function source(id: string, overrides: Partial<SourceRecord> = {}): SourceRecord {
  return { id, workspaceId: "workspace", name: `${id}.pdf`, mime: "application/pdf", bytes: 1024,
    sha256: "ab".repeat(32), version: 0, uploadState: "uploaded", parseState: "ready",
    error: null, createdAt: "2026-10-02T00:00:00Z", ...overrides };
}
const options = { query: "", kind: "all", status: "all", sort: "newest", page: 1, pageSize: 20 } as const;

describe("material collection", () => {
  it("combines name, format and parsing-state filters without changing source records", () => {
    const rows = [source("math", { name: "Math NOTES.pdf", parseState: "running" }),
      source("image", { name: "Math notes.png", mime: "image/png", parseState: "running" }), source("ready")];
    const selected = collectMaterials(rows, { ...options, query: "  NOTES  ", kind: "pdf", status: "parsing" });
    expect(selected.items.map(item => item.id)).toEqual(["math"]);
    expect(selected.total).toBe(1);
    expect(rows.map(item => item.id)).toEqual(["math", "image", "ready"]);
  });
  it("splits incomplete upload from parsing and does not treat pending or unsupported as ready", () => {
    const rows = [
      source("pending", { uploadState: "pending", parseState: "not_started" }),
      source("queued", { parseState: "queued" }),
      source("running", { parseState: "running" }),
      source("stored", { parseState: "unsupported" }),
      source("failed", { parseState: "failed" }),
      source("rejected", { uploadState: "rejected" }),
      source("ready"),
    ];
    expect(collectMaterials(rows, { ...options, status: "ready" }).items.map(item => item.id)).toEqual(["ready"]);
    expect(collectMaterials(rows, { ...options, status: "attention" }).items.map(item => item.id).sort()).toEqual(["failed", "rejected"]);
    expect(collectMaterials(rows, { ...options, status: "stored" }).items.map(item => item.id)).toEqual(["stored"]);
    expect(collectMaterials(rows, { ...options, status: "incomplete_upload" }).items.map(item => item.id)).toEqual(["pending"]);
    expect(collectMaterials(rows, { ...options, status: "parsing" }).items.map(item => item.id).sort()).toEqual(["queued", "running"]);
    expect(materialStatus(rows[0]!)).toBe("incomplete_upload");
    expect(materialStatus(rows[1]!)).toBe("parsing");
    expect(materialStatus(rows[2]!)).toBe("parsing");
  });
  it("maps not_started uploaded rows to parsing", () => {
    expect(materialStatus(source("n", { parseState: "not_started" }))).toBe("parsing");
  });
  it("sorts newest first with stable ties and clamps pagination after deletion or filtering", () => {
    const rows = Array.from({ length: 45 }, (_, i) => source(String(i).padStart(2, "0"), { createdAt: new Date(2026, 0, i + 1).toISOString() }));
    const page = collectMaterials(rows, { ...options, page: 2 });
    expect(page.total).toBe(45);
    expect(page.pages).toBe(3);
    expect(page.items).toHaveLength(20);
    expect(page.items[0]?.id).toBe("24");
    expect(collectMaterials(rows.slice(0, 3), { ...options, page: 3 }).page).toBe(1);
    expect(collectMaterials([source("b"), source("a")], options).items.map(item => item.id)).toEqual(["a", "b"]);
  });
  it("supports size and name ordering and an empty result", () => {
    const rows = [source("b", { bytes: 3 }), source("a", { bytes: 8 })];
    expect(collectMaterials(rows, { ...options, sort: "largest" }).items.map(item => item.id)).toEqual(["a", "b"]);
    expect(collectMaterials(rows, { ...options, sort: "name" }).items.map(item => item.id)).toEqual(["a", "b"]);
    const empty = collectMaterials(rows, { ...options, query: "missing" });
    expect(empty).toMatchObject({ items: [], total: 0, pages: 1, page: 1 });
  });
});
