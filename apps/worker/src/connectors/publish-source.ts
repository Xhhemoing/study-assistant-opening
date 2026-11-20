import { createHash, randomUUID } from "node:crypto";
import { loadOpeningUploadQuota } from "@aistudy/config";
import { uploadInputSchema, type SourceMime } from "@aistudy/contracts";
import type { createOpeningImportsRepository, OpeningImportCommit, OpeningScope } from "@aistudy/database";

export type ConnectorSourceStorage = {
  upload(input: { key: string; bytes: Uint8Array; mime: string }): Promise<void>;
  remove(key: string): Promise<void>;
};

export async function publishConnectorSource(
  imports: ReturnType<typeof createOpeningImportsRepository>, storage: ConnectorSourceStorage, scope: OpeningScope,
  input: Omit<OpeningImportCommit, "sourceId"> & { name: string; mime: SourceMime; bytes: Uint8Array },
) {
  const sourceId = randomUUID();
  const source = uploadInputSchema.parse({
    name: input.name, mime: input.mime, bytes: input.bytes.byteLength,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
  });
  // The unique final key is private staging until its source transaction commits.
  const key = `opening/sources/${sourceId}/v0`;
  const quota = loadOpeningUploadQuota();
  let publicationStarted = false;
  let receipt: Awaited<ReturnType<typeof imports.publish>>;
  try {
    await storage.upload({ key, bytes: input.bytes, mime: source.mime });
    publicationStarted = true;
    receipt = await imports.publish(scope, {
      identity: input.identity, connectionVersion: input.connectionVersion, cursor: input.cursor,
      sourceId, source, key, quota,
    });
  } catch (error) {
    try {
      if (!publicationStarted || !await imports.isSourcePublished(scope, sourceId)) await storage.remove(key);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Connector publication failed and object cleanup could not be confirmed");
    }
    throw error;
  }
  if (receipt.duplicate) await storage.remove(key);
  return receipt;
}
