import { createMockProvider } from "./mock/provider";
import { browserStorage } from "./mock/storage";
import { withPersistedAttempts } from "./persist-attempt";
import { withPersistedReviews } from "./persist-review";
import type { SearchableDocument, StudyDataProvider } from "./types";
import { searchableDocumentsResponseSchema } from "@aistudy/contracts";

async function fetchDocuments(): Promise<SearchableDocument[]> {
  const response = await fetch("/api/documents", { cache: "no-store" });
  if (!response.ok) throw new Error("笔记加载失败");
  return searchableDocumentsResponseSchema.parse(await response.json()).documents;
}

/** Demo/mock study provider for non-production preview and tests only. */
export function createLegacyStudyProvider(userId: string): StudyDataProvider {
  return withPersistedReviews(
    withPersistedAttempts(createMockProvider({ userId, storage: browserStorage(), fetchDocuments })),
  );
}
