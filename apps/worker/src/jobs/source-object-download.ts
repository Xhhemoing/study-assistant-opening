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
  canonicalKey: string,
): candidate is string {
  if (typeof candidate !== "string" || candidate === canonicalKey) return false;
  const ownPrefix = `opening/sources/${sourceId.toLowerCase()}/`;
  const lower = candidate.toLowerCase();
  return lower === canonicalKey.toLowerCase() && lower.startsWith(ownPrefix) && !candidate.includes("..");
}

async function resolveFallbackKeys(input: {
  scope: OpeningScope;
  sourceId: string;
  canonicalKey: string;
  jobKey: string;
  payload: unknown;
  sources: LegacyFinalKeyResolver;
}): Promise<string[]> {
  const candidates: string[] = [];
  const add = (value: unknown) => {
    if (validLegacyFinalKey(value, input.sourceId, input.canonicalKey) && !candidates.includes(value)) {
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
  if (typeof input.storage.objectExists === "function") {
    let selectedKey = canonicalKey;
    if (!(await input.storage.objectExists(canonicalKey))) {
      const fallbacks = await resolveFallbackKeys({
        scope: input.scope,
        sourceId: input.source.id,
        canonicalKey,
        jobKey: input.job.key,
        payload: input.payload,
        sources: input.sources,
      });
      for (const fallbackKey of fallbacks) {
        if (await input.storage.objectExists(fallbackKey)) {
          selectedKey = fallbackKey;
          break;
        }
      }
    }
    const url = await input.storage.presignGet(selectedKey, PRESIGN_OPTIONS);
    return input.signal ? fetch(url, { signal: input.signal }) : fetch(url);
  }

  const canonicalUrl = await input.storage.presignGet(canonicalKey, PRESIGN_OPTIONS);
  const first = input.signal ? await fetch(canonicalUrl, { signal: input.signal }) : await fetch(canonicalUrl);
  if (first.ok) return first;

  const fallbacks = await resolveFallbackKeys({
    scope: input.scope,
    sourceId: input.source.id,
    canonicalKey,
    jobKey: input.job.key,
    payload: input.payload,
    sources: input.sources,
  });
  for (const fallbackKey of fallbacks) {
    void first.body?.cancel().catch(() => undefined);
    const fallbackUrl = await input.storage.presignGet(fallbackKey, PRESIGN_OPTIONS);
    const response = input.signal ? await fetch(fallbackUrl, { signal: input.signal }) : await fetch(fallbackUrl);
    if (response.ok) return response;
    void response.body?.cancel().catch(() => undefined);
  }
  return first;
}
