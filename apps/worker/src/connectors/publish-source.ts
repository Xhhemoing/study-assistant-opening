import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadOpeningUploadQuota } from "@aistudy/config";
import { uploadInputSchema, type SourceMime } from "@aistudy/contracts";
import type { createOpeningImportsRepository, OpeningImportCommit, OpeningScope } from "@aistudy/database";

export type ConnectorSourceStorage = {
  upload(input: { key: string; bytes: Uint8Array; mime: string }): Promise<void>;
  remove(key: string): Promise<void>;
};

type ConnectorImports = Pick<ReturnType<typeof createOpeningImportsRepository>, "publish" | "removeUnpublishedSource">;

function sourceObjectId(workspaceId: string, identity: OpeningImportCommit["identity"], sha256: string) {
  const bytes = createHash("sha256").update(JSON.stringify([
    "opening-connector-source", workspaceId, identity.connectionId, identity.container,
    identity.generation, identity.remoteId, sha256,
  ])).digest().subarray(0, 16);
  // A name-derived UUID keeps all source readers on the existing object layout.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function removeWithRetry(storage: ConnectorSourceStorage, key: string) {
  for (const backoffMs of [25, 50]) {
    try {
      await storage.remove(key);
      return;
    } catch {
      await delay(backoffMs);
    }
  }
  await storage.remove(key);
}

export async function publishConnectorSource(
  imports: ConnectorImports, storage: ConnectorSourceStorage, scope: OpeningScope,
  input: Omit<OpeningImportCommit, "sourceId"> & { name: string; mime: SourceMime; bytes: Uint8Array },
) {
  const source = uploadInputSchema.parse({
    name: input.name, mime: input.mime, bytes: input.bytes.byteLength,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
  });
  const sourceId = sourceObjectId(scope.workspaceId, input.identity, source.sha256);
  // The final key is private staging until its source transaction commits.
  const key = `opening/sources/${sourceId}/v0`;
  const quota = loadOpeningUploadQuota();
  const cleanup = () => imports.removeUnpublishedSource(scope, input.identity, sourceId, () => removeWithRetry(storage, key));
  let receipt: Awaited<ReturnType<typeof imports.publish>>;
  try {
    receipt = await imports.publish(scope, {
      identity: input.identity, connectionVersion: input.connectionVersion, cursor: input.cursor,
      sourceId, source, key, quota,
    }, () => storage.upload({ key, bytes: input.bytes, mime: source.mime }));
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Connector publication failed and object cleanup could not be confirmed");
    }
    throw error;
  }
  if (receipt.duplicate && !receipt.sourceIds.includes(sourceId)) await cleanup();
  return receipt;
}
