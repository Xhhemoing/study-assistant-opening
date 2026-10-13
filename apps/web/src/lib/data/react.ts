"use client";

import { useCallback, useEffect, useState } from "react";
import type { StudyDataProvider } from "./types";

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

/**
 * Legacy demo study provider hook.
 * Production builds compare process.env.NODE_ENV directly so webpack can
 * eliminate the dynamic demo import (no seed bundles in .next/static).
 */
export function useStudyProvider(): StudyDataProvider | null {
  const userId = useCurrentUserId();
  const [provider, setProvider] = useState<StudyDataProvider | null>(null);

  useEffect(() => {
    if (!userId || process.env.NODE_ENV === "production") {
      setProvider(null);
      return;
    }
    let cancelled = false;
    void import("./demo-study-provider").then((mod) => {
      if (!cancelled) setProvider(mod.createLegacyStudyProvider(userId));
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return provider;
}
