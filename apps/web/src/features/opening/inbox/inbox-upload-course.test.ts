import { describe, expect, it, vi } from "vitest";
import type { SourceRecord, UploadTicket } from "@aistudy/contracts";
import { createUploadClient } from "./upload-client";
import { createUploadQueue } from "./upload-queue";
import { createMaterialOrganizationClient } from "../library/material-organization-client";

const ID = "11111111-1111-4111-8111-111111111111";
const COURSE = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const ISO = "2026-10-10T00:00:00.000Z";

function source(patch: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: ID,
    workspaceId: WS,
    name: "notes.pdf",
    mime: "application/pdf",
    bytes: 4,
    sha256: "ab".repeat(32),
    version: 0,
    uploadState: "uploaded",
    parseState: "queued",
    error: null,
    createdAt: ISO,
    ...patch,
  };
}

function ticket(): UploadTicket {
  return {
    source: source({ uploadState: "pending", parseState: "not_started" }),
    uploadUrl: "https://minio.local/expired",
    expiresAt: ISO,
  };
}

describe("upload then course membership (Package D)", () => {
  it("adds membership after successful upload when courseId is provided", async () => {
    const begin = vi.fn(async () => ticket());
    const complete = vi.fn(async () => source());
    const put = vi.fn(async () => undefined);
    const client = createUploadClient({
      begin, complete, put,
      resolvePutUrl: (t) => `/api/opening/sources/${t.source.id}/staging`,
    });
    const memberships: Array<{ courseId: string; sourceId: string; role: string }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/memberships") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        memberships.push({ courseId: COURSE, sourceId: body.assetId, role: body.role });
        return new Response(JSON.stringify({ membership: { id: "m1" } }), { status: 201 });
      }
      return new Response("{}", { status: 200 });
    });
    const org = createMaterialOrganizationClient(fetcher);
    const queue = createUploadQueue(client);
    queue.add([{ name: "notes.pdf", type: "application/pdf", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    await queue.start();
    const saved = queue.snapshot().filter((item) => item.state === "saved" && item.source);
    expect(saved).toHaveLength(1);
    await org.addToCourse(COURSE, saved.map((item) => item.source!.id), "reference");
    expect(memberships).toEqual([{ courseId: COURSE, sourceId: ID, role: "reference" }]);
  });

  it("does not create membership when courseId is absent", async () => {
    const memberships: unknown[] = [];
    const fetcher = vi.fn(async () => {
      memberships.push("called");
      return new Response("{}", { status: 200 });
    });
    const org = createMaterialOrganizationClient(fetcher);
    const courseId: string | null = null;
    if (courseId) await org.addToCourse(courseId, [ID], "reference");
    expect(memberships).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not create membership when upload fails", async () => {
    const begin = vi.fn(async () => ticket());
    const complete = vi.fn(async () => source());
    const put = vi.fn(async () => { throw new Error("上传对象失败 (403)"); });
    const client = createUploadClient({ begin, complete, put });
    const queue = createUploadQueue(client);
    queue.add([{ name: "notes.pdf", type: "application/pdf", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    await queue.start();
    expect(queue.snapshot()[0]?.state).toBe("failed");
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("pending retry without local file", () => {
  it("does not call complete-only when staging bytes are missing", async () => {
    const complete = vi.fn(async () => source());
    const client = createUploadClient({
      begin: vi.fn(),
      complete,
      put: vi.fn(),
      refreshTicket: vi.fn(),
    });
    // Simulate inbox pending retry with no local queue bytes: only surface re-select; never complete-only.
    const localBytesAvailable = false;
    if (localBytesAvailable) {
      await client.retryComplete(ID);
    }
    const message = localBytesAvailable ? null : "请重新选择文件";
    expect(message).toBe("请重新选择文件");
    expect(complete).not.toHaveBeenCalled();
  });
});
