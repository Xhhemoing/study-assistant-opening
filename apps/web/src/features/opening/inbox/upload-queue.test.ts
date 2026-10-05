import { describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { createUploadQueue } from "./upload-queue";
import { createUploadClient, type LocalUploadFile } from "./upload-client";

const source: SourceRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  name: "notes.pdf",
  mime: "application/pdf",
  bytes: 4,
  sha256: "ab".repeat(32),
  version: 0,
  uploadState: "uploaded",
  parseState: "queued",
  error: null,
  createdAt: "2026-10-04T00:00:00.000Z",
};

function file(name: string): LocalUploadFile {
  return { name, type: "application/pdf", bytes: new Uint8Array([1, 2, 3, 4]) };
}

describe("createUploadQueue", () => {
  it("accepts initial files as idle items and preserves their File object", () => {
    const initial = file("initial.pdf");
    const queue = createUploadQueue(vi.fn(), [initial]);

    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.state).toBe("idle");
    expect(queue.snapshot()[0]?.file).toBe(initial);
  });

  it("continues with later files when one upload fails", async () => {
    const upload = vi.fn(async (input: LocalUploadFile) => {
      if (input.name === "broken.pdf") {
        return { phase: "interrupted", keptLocal: true, message: "网络中断" } as const;
      }
      return { ...source, name: input.name };
    });
    const queue = createUploadQueue(upload);
    queue.add([file("broken.pdf"), file("saved.pdf")]);

    await queue.start();

    expect(upload).toHaveBeenCalledTimes(2);
    expect(queue.snapshot().map((item) => item.state)).toEqual(["failed", "saved"]);
    expect(queue.snapshot()[0]?.message).toBe("网络中断");
  });

  it("retries a failed item without reprocessing completed files", async () => {
    let attempts = 0;
    const upload = vi.fn(async (input: LocalUploadFile) => {
      attempts += 1;
      if (attempts === 1) return { phase: "interrupted", keptLocal: true, message: "网络中断" } as const;
      return { ...source, name: input.name };
    });
    const queue = createUploadQueue(upload);
    const [item] = queue.add([file("retry.pdf")]);

    await queue.start();
    await queue.retry(item!.id);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(queue.snapshot()[0]?.state).toBe("saved");
  });

  it("retries complete failure with the same ticket without beginning again", async () => {
    const ticket = {
      source: { ...source, uploadState: "pending" as const },
      uploadUrl: "https://minio.local/upload",
      expiresAt: "2026-10-04T00:00:00.000Z",
    };
    const begin = vi.fn(async () => ticket);
    let completeAttempts = 0;
    const complete = vi.fn(async () => {
      completeAttempts += 1;
      if (completeAttempts === 1) throw new Error("complete unavailable");
      return { ...source, uploadState: "uploaded" as const };
    });
    const put = vi.fn(async () => undefined);
    const client = createUploadClient({ begin, complete, put });
    const initial = file("complete-retry.pdf");
    const queue = createUploadQueue(client, [initial]);

    await queue.start();
    const failed = queue.snapshot()[0];
    expect(failed?.state).toBe("failed");
    expect(failed?.file).toBe(initial);
    expect(failed?.ticket).toBe(ticket);

    await queue.retry(failed!.id);

    expect(queue.snapshot()[0]?.state).toBe("saved");
    expect(begin).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("emits uploading progress and saved snapshots to the update callback", async () => {
    const updates: Array<{ state: string; progress: number }> = [];
    const client = {
      uploadFile: vi.fn(async (_input: LocalUploadFile, progress?: { onBytes?: (loaded: number, total: number) => void }) => {
        progress?.onBytes?.(5, 10);
        return source;
      }),
    };
    const queue = createUploadQueue(client, [file("progress.pdf")]);

    await queue.start((items) => {
      const item = items[0];
      if (item) updates.push({ state: item.state, progress: item.progress });
    });

    expect(updates).toEqual([
      { state: "uploading", progress: 0 },
      { state: "uploading", progress: 50 },
      { state: "saved", progress: 100 },
    ]);
  });

  it("reports begin rejection as an interrupted upload", async () => {
    const client = createUploadClient({
      begin: vi.fn(async () => { throw new Error("begin unavailable"); }),
      complete: vi.fn(),
      put: vi.fn(),
    });

    await expect(client.uploadFile(file("begin-failure.pdf"))).resolves.toMatchObject({
      phase: "interrupted",
      keptLocal: true,
      message: "上传准备失败，原件仍在本地。",
    });
  });

  it("clamps invalid progress values to the 0..100 range", async () => {
    const updates: number[] = [];
    const client = {
      uploadFile: vi.fn(async (_input: LocalUploadFile, progress?: { onBytes?: (loaded: number, total: number) => void }) => {
        progress?.onBytes?.(-1, 10);
        progress?.onBytes?.(Number.NaN, 10);
        progress?.onBytes?.(15, 10);
        return source;
      }),
    };
    const queue = createUploadQueue(client, [file("bounds.pdf")]);
    await queue.start((items) => {
      const progress = items[0]?.progress;
      if (progress !== undefined) updates.push(progress);
    });

    expect(updates).toContain(0);
    expect(updates).toContain(100);
    expect(updates.every((progress) => Number.isFinite(progress) && progress >= 0 && progress <= 100)).toBe(true);
  });
});
