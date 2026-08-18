"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { searchableDocumentsResponseSchema } from "@aistudy/contracts";
import { createMockProvider } from "./mock/provider";
import { browserStorage } from "./mock/storage";
import { withPersistedAttempts } from "./persist-attempt";
import { withPersistedReviews } from "./persist-review";
import type { SearchableDocument, StudyDataProvider } from "./types";

const LOAD_ERROR = "加载失败，请重试。";

export interface AsyncData<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useAsyncData<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncData<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setData(undefined);
    Promise.resolve()
      .then(load)
      .then((value) => {
        if (active) setData(value);
      })
      .catch(() => {
        if (active) {
          setData(undefined);
          setError(LOAD_ERROR);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, reloadToken, ...deps]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);
  return { data, error, loading, reload };
}

export function fetchCurrentUserId(): Promise<string | null> {
  return fetch("/api/auth/me", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return null;
      const body = await response.json() as { user?: { id?: string } };
      return body.user?.id ?? null;
    })
    .catch(() => null);
}

export function useCurrentUserId(): string | null {
  const result = useAsyncData(fetchCurrentUserId, []);
  return result.data ?? null;
}

async function fetchDocuments(): Promise<SearchableDocument[]> {
  const response = await fetch("/api/documents", { cache: "no-store" });
  if (!response.ok) throw new Error("笔记加载失败");
  return searchableDocumentsResponseSchema.parse(await response.json()).documents;
}

export function useStudyProvider(): StudyDataProvider | null {
  const userId = useCurrentUserId();
  return useMemo(() => {
    if (!userId) return null;
    return withPersistedReviews(
      withPersistedAttempts(createMockProvider({ userId, storage: browserStorage(), fetchDocuments })),
    );
  }, [userId]);
}
