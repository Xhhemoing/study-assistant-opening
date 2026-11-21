import { expect, it, vi } from "vitest";
import { publishConnectorSource } from "./publish-source";

type Imports = Parameters<typeof publishConnectorSource>[0];

it("reconciles the same unreferenced object on redelivery after bounded delete retries", async () => {
  const objects = new Set<string>();
  let storageHealthy = false;
  const uploadSignals: (AbortSignal | undefined)[] = [];
  const storage = {
    upload: vi.fn(async ({ key, signal }: { key: string; signal?: AbortSignal }) => {
      uploadSignals.push(signal);
      objects.add(key);
    }),
    remove: vi.fn(async (key: string) => {
      if (!storageHealthy) throw new Error("delete temporarily unavailable");
      objects.delete(key);
    }),
  };
  const duplicate = { id: "receipt", sourceIds: ["legacy-source"], duplicate: true, connectionVersion: 1 };
  const imports: Imports = {
    publish: vi.fn<Imports["publish"]>(async (_scope, _input, stage) => {
      await stage();
      return duplicate;
    }),
    removeUnpublishedSource: vi.fn<Imports["removeUnpublishedSource"]>(async (_scope, _identity, _sourceId, _key, _byteSize, remove) => {
      await remove();
    }),
  };
  const scope = { workspaceId: "workspace", ownerUserId: "owner" };
  const delivery = {
    connectionVersion: 1,
    identity: { connectionId: "connection", container: "INBOX", generation: "42", remoteId: "11" },
    name: "message.eml", mime: "message/rfc822" as const, bytes: Buffer.from("Subject: Message\r\n\r\nTest"),
  };

  await expect(publishConnectorSource(imports, storage, scope, delivery)).rejects.toThrow("delete temporarily unavailable");
  const [firstKey] = objects;
  expect(objects.size).toBe(1);
  expect(storage.remove.mock.calls).toEqual([[firstKey], [firstKey], [firstKey]]);

  storageHealthy = true;
  await expect(publishConnectorSource(imports, storage, scope, delivery)).resolves.toEqual(duplicate);
  expect(storage.remove).toHaveBeenCalledTimes(4);
  expect(objects.size).toBe(1);
  expect(objects.has(firstKey)).toBe(true);
  expect(uploadSignals).toHaveLength(2);
  expect(uploadSignals.every(signal => signal instanceof AbortSignal)).toBe(true);
});

it("forwards putUncertain accurately across pre-PUT, upload failure, and post-upload DB failure", async () => {
  const scope = { workspaceId: "workspace", ownerUserId: "owner" };
  const delivery = {
    connectionVersion: 1,
    identity: { connectionId: "connection", container: "INBOX", generation: "42", remoteId: "11" },
    name: "message.eml", mime: "message/rfc822" as const, bytes: Buffer.from("Subject: Msg\r\n\r\nBody"),
  };
  const removeSpy = vi.fn(async () => undefined);
  const removeUnpublishedSource = vi.fn(async () => undefined);

  // Pre-PUT failure: publish rejects before entering stage().
  const prePutImports: Imports = {
    publish: vi.fn(async () => { throw new Error("connection locked"); }),
    removeUnpublishedSource,
  };
  await expect(publishConnectorSource(prePutImports, { upload: vi.fn(), remove: removeSpy }, scope, delivery))
    .rejects.toThrow("connection locked");
  expect(removeUnpublishedSource).not.toHaveBeenCalled();

  // Uncertain PUT failure: storage.upload starts then aborts/throws -> putUncertain: true.
  const putErrorImports: Imports = {
    publish: vi.fn(async (_s, _i, stage) => { await stage(); throw new Error("unreachable"); }),
    removeUnpublishedSource,
  };
  await expect(publishConnectorSource(putErrorImports, {
    upload: vi.fn(async () => { throw new Error("PUT timed out"); }),
    remove: removeSpy,
  }, scope, delivery)).rejects.toThrow("PUT timed out");
  expect(removeUnpublishedSource).toHaveBeenLastCalledWith(
    scope,
    delivery.identity,
    expect.any(String),
    expect.stringMatching(/^opening\/sources\/.+\/v0$/),
    delivery.bytes.byteLength,
    expect.any(Function),
    { putUncertain: true },
  );

  // Post-upload DB failure: storage.upload succeeded cleanly -> putUncertain: false so reservation releases immediately.
  const dbErrorImports: Imports = {
    publish: vi.fn(async (_s, _i, stage) => {
      await stage();
      throw new Error("receipt check constraint failed");
    }),
    removeUnpublishedSource,
  };
  await expect(publishConnectorSource(dbErrorImports, {
    upload: vi.fn(async () => undefined),
    remove: removeSpy,
  }, scope, delivery)).rejects.toThrow("receipt check constraint failed");
  expect(removeUnpublishedSource).toHaveBeenLastCalledWith(
    scope,
    delivery.identity,
    expect.any(String),
    expect.stringMatching(/^opening\/sources\/.+\/v0$/),
    delivery.bytes.byteLength,
    expect.any(Function),
    { putUncertain: false },
  );
});
