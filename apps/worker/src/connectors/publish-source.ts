import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadOpeningUploadQuota } from "@aistudy/config";
import { uploadInputSchema, type SourceMime } from "@aistudy/contracts";
import { CONNECTOR_PUT_TIMEOUT_MS, type createOpeningImportsRepository, type OpeningImportCommit, type OpeningScope } from "@aistudy/database";

export type ConnectorSourceStorage = {
  upload(input: { key: string; bytes: Uint8Array; mime: string; signal?: AbortSignal }): Promise<void>;
  remove(key: string): Promise<void>;
};

type ConnectorImports = Pick<
  ReturnType<typeof createOpeningImportsRepository>,
  "publish" | "removeUnpublishedSource" | "refreshConnectorReservationCutoff"
>;

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
  // Receipt identity is the connector's idempotency key. Keep each physical
  // upload attempt independent so failed object cleanup cannot reserve a later
  // delivery's source identity.
  const sourceId = randomUUID();
  // The final key is private staging until its source transaction commits.
  const key = `opening/sources/${sourceId}/v0`;
  const quota = loadOpeningUploadQuota();
  let staged = false;
  let putUncertain = false;
  const cleanup = (uncertain: boolean) => imports.removeUnpublishedSource(
    scope, input.identity, sourceId, key, source.bytes, () => removeWithRetry(storage, key),
    { putUncertain: uncertain },
  );
  let receipt: Awaited<ReturnType<typeof imports.publish>>;
  try {
    receipt = await imports.publish(scope, {
      identity: input.identity, connectionVersion: input.connectionVersion, cursor: input.cursor,
      sourceId, source, key, quota,
    }, async () => {
      await imports.refreshConnectorReservationCutoff(scope, sourceId, key);
      staged = true;
      putUncertain = true;
      await storage.upload({
        key,
        bytes: input.bytes,
        mime: source.mime,
        signal: AbortSignal.timeout(CONNECTOR_PUT_TIMEOUT_MS),
      });
      putUncertain = false;
    });
  } catch (error) {
    if (staged) {
      try {
        await cleanup(putUncertain);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Connector publication failed and object cleanup could not be confirmed");
      }
    }
    throw error;
  }
  if (staged && receipt.duplicate && !receipt.sourceIds.includes(sourceId)) await cleanup(false);
  return receipt;
}
