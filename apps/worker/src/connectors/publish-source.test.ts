import { expect, it, vi } from "vitest";
import { publishConnectorSource } from "./publish-source";

type Imports = Parameters<typeof publishConnectorSource>[0];

it("reconciles the same unreferenced object on redelivery after bounded delete retries", async () => {
  const objects = new Set<string>();
  let storageHealthy = false;
  const storage = {
    upload: vi.fn(async ({ key }: { key: string }) => { objects.add(key); }),
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
    removeUnpublishedSource: vi.fn<Imports["removeUnpublishedSource"]>(async (_scope, _identity, _sourceId, _key, remove) => {
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
  const [stagedKey] = objects;
  expect(objects.size).toBe(1);
  expect(storage.remove.mock.calls).toEqual([[stagedKey], [stagedKey], [stagedKey]]);

  storageHealthy = true;
  await expect(publishConnectorSource(imports, storage, scope, delivery)).resolves.toEqual(duplicate);
  expect(storage.remove).toHaveBeenLastCalledWith(stagedKey);
  expect(objects.size).toBe(0);
});
