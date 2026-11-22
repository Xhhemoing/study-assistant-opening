import type { OpeningJobRecord, OpeningScope } from "@aistudy/database";

export type SourceDownloadStorage = {
  presignGet(
    key: string,
    input: { expiresInSeconds: number; responseContentDisposition: string; responseCacheControl: string },
  ): Promise<string>;
  finalKey(id: string, version: number): string;
  objectExists?(key: string): Promise<boolean>;
};

export type LegacyFinalKeyResolver = {
  resolveLegacyFinalKey?(
    scope: OpeningScope,
    sourceId: string,
    canonicalFinalKey: string,
  ): Promise<string | null>;
};

const PRESIGN_OPTIONS = {
  expiresInSeconds: 900,
  responseContentDisposition: "attachment",
  responseCacheControl: "private, no-store",
} as const;

function validLegacyFinalKey(
  candidate: unknown,
  sourceId: string,
  sourceVersion: number,
  canonicalKey: string,
): candidate is string {
  if (typeof candidate !== "string" || candidate === canonicalKey) return false;
  const ownVersionKey = `opening/sources/${sourceId.toLowerCase()}/v${sourceVersion}`;
  const lower = candidate.toLowerCase();
  return lower === canonicalKey.toLowerCase() && lower === ownVersionKey && !candidate.includes("..");
}

async function resolveFallbackKeys(input: {
  scope: OpeningScope;
  sourceId: string;
  sourceVersion: number;
  canonicalKey: string;
  jobKey: string;
  payload: unknown;
  sources: LegacyFinalKeyResolver;
}): Promise<string[]> {
  const candidates: string[] = [];
  const add = (value: unknown) => {
    if (validLegacyFinalKey(value, input.sourceId, input.sourceVersion, input.canonicalKey) && !candidates.includes(value)) {
      candidates.push(value);
    }
  };
  add((input.payload as { objectKey?: unknown } | null)?.objectKey);
  add(input.jobKey);
  if (candidates.length === 0 && input.sources.resolveLegacyFinalKey) {
    add(await input.sources.resolveLegacyFinalKey(input.scope, input.sourceId, input.canonicalKey));
  }
  return candidates;
}

/**
 * Fetches a source object via canonical lowercase finalKey first, falling back
 * to a verified historical mixed-case object key when missing in storage.
 */
export async function fetchPresignedSourceObject(input: {
  scope: OpeningScope;
  source: { id: string; version: number };
  job: Pick<OpeningJobRecord, "key">;
  payload: unknown;
  storage: SourceDownloadStorage;
  sources: LegacyFinalKeyResolver;
  signal?: AbortSignal;
}): Promise<Response> {
  const canonicalKey = input.storage.finalKey(input.source.id, input.source.version);
  const download = async (key: string) => {
    input.signal?.throwIfAborted();
    const url = await input.storage.presignGet(key, PRESIGN_OPTIONS);
    return input.signal ? fetch(url, { signal: input.signal }) : fetch(url);
  };
  let first: Response | undefined;
  let firstError: unknown;
  try {
    first = await download(canonicalKey);
    if (first.ok) return first;
    void first.body?.cancel().catch(() => undefined);
  } catch (error) {
    if (input.signal?.aborted) throw error;
    firstError = error;
  }

  const fallbacks = await resolveFallbackKeys({
    scope: input.scope,
    sourceId: input.source.id,
    sourceVersion: input.source.version,
    canonicalKey,
    jobKey: input.job.key,
    payload: input.payload,
    sources: input.sources,
  }).catch(() => []); // A failed legacy lookup cannot recover the canonical download.
  input.signal?.throwIfAborted();
  for (const fallbackKey of fallbacks) {
    try {
      const response = await download(fallbackKey);
      if (response.ok) return response;
      void response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (input.signal?.aborted) throw error;
    }
  }
  if (first) return first;
  throw firstError;
}
