import { describe, expect, it, vi } from "vitest";
import type { SourceRecord, UploadTicket } from "@aistudy/contracts";
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
  it("retains an unknown begin identity through legacy adapters and gives a new selection a new identity", async () => {
    const begins: string[] = [];
    const client = createUploadClient({
      begin: async input => {
        begins.push(input.uploadId!);
        if (begins.length === 1) throw new Error("begin response lost");
        return { source: { ...source, id: input.uploadId!, uploadState: "pending" }, uploadUrl: "https://minio.local/upload", expiresAt: source.createdAt };
      },
      put: async () => {}, complete: async id => ({ ...source, id }),
    });
    const selected = file("same.pdf");
    const queue = createUploadQueue((input, onBytes, resume, operation) => client.uploadFile(input, { uploadId: operation?.uploadId, onBytes, resumeSourceId: resume?.sourceId, ticket: resume?.ticket }));
    const [first] = queue.add([selected]);
    await queue.start();
    await queue.retry(first!.id);
    expect(begins[0]).toBe(first!.id);
    expect(begins[1]).toBe(first!.id);
    expect(queue.snapshot()[0]?.state).toBe("saved");
    const [next] = queue.add([selected]);
    await queue.start();
    expect(next!.id).not.toBe(first!.id);
    expect(begins[2]).toBe(next!.id);
  });

  it("accepts initial files as idle items and preserves their File object", () => {
    const initial = file("initial.pdf");
    const queue = createUploadQueue(vi.fn(async (): Promise<SourceRecord> => source), [initial]);

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
    const ticket: UploadTicket = {
      source: { ...source, uploadState: "pending" as const },
      uploadUrl: "https://minio.local/upload",
      expiresAt: "2026-10-04T00:00:00.000Z",
    };
    const begin = vi.fn(async () => ticket);
    const refreshTicket = vi.fn(async () => ({
      ...ticket,
      uploadUrl: "https://minio.local/reissued",
      expiresAt: "2026-10-04T00:20:00.000Z",
    }));
    let completeAttempts = 0;
    const complete = vi.fn(async () => {
      completeAttempts += 1;
      if (completeAttempts === 1) throw new Error("complete unavailable");
      return { ...source, uploadState: "uploaded" as const };
    });
    const putUrls: string[] = [];
    const put = vi.fn(async (url: string) => { putUrls.push(url); });
    const resolvePutUrl = (t: UploadTicket) => `/api/opening/sources/${t.source.id}/staging`;
    const client = createUploadClient({ begin, complete, put, refreshTicket, resolvePutUrl });
    const initial = file("complete-retry.pdf");
    const queue = createUploadQueue(client, [initial]);

    await queue.start();
    const failed = queue.snapshot()[0];
    expect(failed?.state).toBe("failed");
    expect(failed?.file).toBe(initial);
    expect(failed?.ticket?.source.id).toBe(ticket.source.id);

    await queue.retry(failed!.id);

    expect(queue.snapshot()[0]?.state).toBe("saved");
    expect(begin).toHaveBeenCalledTimes(1);
    expect(refreshTicket).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
    expect(putUrls.every((url) => url === `/api/opening/sources/${source.id}/staging`)).toBe(true);
    expect(putUrls.join("\n")).not.toContain("127.0.0.1:9000");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("on retry refreshes ticket then PUT then complete (never reuses expired uploadUrl)", async () => {
    const ticket: UploadTicket = {
      source: { ...source, uploadState: "pending" as const },
      uploadUrl: "https://minio.local/expired",
      expiresAt: "2026-10-04T00:00:00.000Z",
    };
    const begin = vi.fn(async () => ticket);
    const refreshTicket = vi.fn(async () => ({
      source: ticket.source,
      uploadUrl: "https://minio.local/fresh",
      expiresAt: "2026-10-04T01:00:00.000Z",
    }));
    const complete = vi.fn(async () => ({ ...source, uploadState: "uploaded" as const }));
    let putCount = 0;
    const put = vi.fn(async (url: string) => {
      putCount += 1;
      if (putCount === 1) throw new Error("上传对象失败 (403)");
      expect(url).toBe(`/api/opening/sources/${source.id}/staging`);
    });
    const client = createUploadClient({
      begin, complete, put, refreshTicket,
      resolvePutUrl: (t) => `/api/opening/sources/${t.source.id}/staging`,
    });
    const queue = createUploadQueue(client, [file("reissue.pdf")]);
    await queue.start();
    expect(queue.snapshot()[0]?.state).toBe("failed");
    await queue.retry(queue.snapshot()[0]!.id);
    expect(queue.snapshot()[0]?.state).toBe("saved");
    expect(begin).toHaveBeenCalledTimes(1);
    expect(refreshTicket).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
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

  it("dismisses saved and failed items from the session queue without re-uploading or changing saved sources", async () => {
    const upload = vi.fn(async (input: LocalUploadFile) => {
      if (input.name === "broken.pdf") {
        return { phase: "interrupted", keptLocal: true, message: "网络中断" } as const;
      }
      return { ...source, name: input.name };
    });
    const queue = createUploadQueue(upload);
    const [failed, saved] = queue.add([file("broken.pdf"), file("ok.pdf")]);
    await queue.start();

    const updates: number[] = [];
    const savedSource = queue.snapshot()[1]?.source;
    queue.dismiss(saved!.id, (items) => updates.push(items.length));
    expect(queue.snapshot().map((item) => item.id)).toEqual([failed!.id]);
    expect(updates).toEqual([1]);
    expect(savedSource).toEqual({ ...source, name: "ok.pdf" });

    queue.dismiss(failed!.id, (items) => updates.push(items.length));
    expect(queue.snapshot()).toEqual([]);
    expect(updates).toEqual([1, 0]);

    queue.dismiss(failed!.id, (items) => updates.push(items.length));
    expect(updates).toEqual([1, 0]);
    await queue.start();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("dismisses idle items from the session queue", () => {
    const upload = vi.fn(async () => source);
    const queue = createUploadQueue(upload);
    const [idle, other] = queue.add([file("waiting.pdf"), file("later.pdf")]);
    expect(queue.snapshot()[0]?.state).toBe("idle");
    const updates: number[] = [];
    queue.dismiss(idle!.id, (items) => updates.push(items.length));
    expect(queue.snapshot().map((item) => item.id)).toEqual([other!.id]);
    expect(updates).toEqual([1]);
  });

  it("dismisses uploading items and ignores late progress or completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const upload = vi.fn(async (_input: LocalUploadFile, onBytes?: (loaded: number, total: number) => void) => {
      onBytes?.(1, 10);
      await gate;
      onBytes?.(10, 10);
      return source;
    });
    const queue = createUploadQueue(upload);
    const [item] = queue.add([file("inflight.pdf")]);
    const progressLengths: number[] = [];
    const startPromise = queue.start((items) => progressLengths.push(items.length));
    // Allow process to enter uploading and emit first progress.
    await vi.waitFor(() => {
      expect(queue.snapshot()[0]?.state).toBe("uploading");
    });
    queue.dismiss(item!.id, (items) => progressLengths.push(items.length));
    expect(queue.snapshot()).toHaveLength(0);
    release();
    await startPromise;
    expect(queue.snapshot()).toHaveLength(0);
    // Late completion must not resurrect the dismissed item.
    expect(progressLengths.at(-1)).toBe(0);
  });

});


it("releases saved buffers while retaining failed bytes and the original ticket for retry", async () => {
  const savedFile = file("saved.pdf"), failedFile = file("failed.pdf");
  const retainedTicket = { source, uploadUrl: "https://example.test/upload", expiresAt: source.createdAt } as UploadTicket;
  const upload = vi.fn(async (input: LocalUploadFile) => input === failedFile
    ? { phase: "interrupted" as const, keptLocal: true as const, ticket: retainedTicket, message: "网络中断" }
    : source);
  const queue = createUploadQueue(upload, [savedFile, failedFile]);
  await queue.start();
  const [saved, failed] = queue.snapshot();
  expect(saved?.file).toEqual({ name: savedFile.name, type: savedFile.type, bytes: new Uint8Array() });
  expect(saved?.source?.bytes).toBe(4);
  expect(savedFile.bytes.byteLength).toBe(4);
  expect(failed?.file).toBe(failedFile);
  expect(failed?.file.bytes.byteLength).toBe(4);
  expect(failed?.ticket).toBe(retainedTicket);
});

function browserFile(name: string, size = 4, type = "application/pdf") {
  return { name, type, size, arrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer) } as unknown as File;
}

it("reads browser files only in their turn and serializes overlapping batches", async () => {
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const first = browserFile("first.pdf"), second = browserFile("second.pdf");
  const client = vi.fn(async (input: LocalUploadFile) => { if (input.name === first.name) await wait; return source; });
  const queue = createUploadQueue(client);
  queue.addFiles([first]);
  expect(first.arrayBuffer).not.toHaveBeenCalled();
  const running = queue.start();
  await vi.waitFor(() => expect(client).toHaveBeenCalledOnce());
  queue.addFiles([second]);
  const overlapping = queue.start();
  expect(overlapping).toBe(running);
  expect(second.arrayBuffer).not.toHaveBeenCalled();
  finish(); await running;
  expect(second.arrayBuffer).toHaveBeenCalledOnce();
  expect(queue.snapshot().map(item => item.state)).toEqual(["saved", "saved"]);
  expect(queue.snapshot().every(item => item.file.bytes.byteLength === 0)).toBe(true);
});

it("retains unread files after a read failure and retries the same queue row", async () => {
  const selected = browserFile("unread.pdf");
  vi.mocked(selected.arrayBuffer).mockRejectedValueOnce(new Error("private disk path /secret"));
  const client = vi.fn(async () => source);
  const queue = createUploadQueue(client);
  const [item] = queue.addFiles([selected]);
  await queue.start();
  expect(queue.snapshot()[0]).toMatchObject({ id: item!.id, state: "failed", message: expect.stringContaining("无法读取文件「unread.pdf」") });
  expect(queue.snapshot()[0]?.message).not.toContain("/secret");
  expect(client).not.toHaveBeenCalled();
  await queue.retry(item!.id);
  expect(selected.arrayBuffer).toHaveBeenCalledTimes(2);
  expect(client).toHaveBeenCalledOnce();
  expect(queue.snapshot()[0]).toMatchObject({ id: item!.id, state: "saved" });
});

it("counts unread and failed buffers across batches before another read can begin", async () => {
  const queue = createUploadQueue(vi.fn(async () => source));
  const large = browserFile("large.mp4", 400 * 1024 * 1024, "video/mp4");
  vi.mocked(large.arrayBuffer).mockRejectedValue(new Error("not readable"));
  const [failed] = queue.addFiles([large]);
  const extra = browserFile("extra.mp4", 120 * 1024 * 1024, "video/mp4");
  expect(() => queue.addFiles([extra])).toThrow("总大小不能超过 512 MiB");
  expect(extra.arrayBuffer).not.toHaveBeenCalled();
  await queue.start();
  expect(() => queue.addFiles([extra])).toThrow("总大小不能超过 512 MiB");
  queue.dismiss(failed!.id);
  queue.addFiles([extra]);
  expect(extra.arrayBuffer).not.toHaveBeenCalled();

  const countQueue = createUploadQueue(vi.fn(async () => { throw new Error("private failure"); }));
  countQueue.addFiles(Array.from({ length: 20 }, (_, index) => browserFile(`${index}.pdf`)));
  await countQueue.start();
  expect(() => countQueue.addFiles([browserFile("extra.pdf")])).toThrow("最多 20 份");
  expect(() => countQueue.add([file("eager.pdf")])).toThrow("最多 20 份");
  expect(countQueue.snapshot()[0]?.message).toBe("上传未完成，原件仍在本地，请重试。");
});


it("drains a batch added while an empty start is settling", async () => {
  const client = vi.fn(async () => source);
  const queue = createUploadQueue(client);
  const emptyStart = queue.start();
  queue.addFiles([browserFile("arrived.pdf")]);
  await queue.start(); await emptyStart;
  expect(client).toHaveBeenCalledOnce();
  expect(queue.snapshot()[0]?.state).toBe("saved");
});
