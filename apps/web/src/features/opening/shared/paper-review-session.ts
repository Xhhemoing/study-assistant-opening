"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { getVerifiedSessionIdentity, type SessionIdentity } from "../../auth/session-identity";
import {
  PAPER_REVIEW_STORAGE_PREFIX,
  registerOpeningPrivacyCleanup,
  subscribeOpeningPrivacyChange,
} from "../client/privacy-change";
export { PAPER_REVIEW_STORAGE_PREFIX };

export type PaperReviewScopeKind = "course" | "goal";

export type PaperReviewScope = {
  kind: PaperReviewScopeKind;
  id: string;
};

export type PaperReviewRequirementRef = {
  id: string;
  revision: number;
};

export const paperReviewItemSchema = z
  .object({
    requirementRevision: z.number().int().positive(),
    markedAt: z.string().min(1),
  })
  .strict();

export const paperReviewSessionStateSchema = z
  .object({
    version: z.literal(1),
    roundNumber: z.number().int().positive(),
    updatedAt: z.string().min(1),
    items: z.record(z.string(), paperReviewItemSchema),
  })
  .strict();

export type PaperReviewItem = z.infer<typeof paperReviewItemSchema>;
export type PaperReviewSessionState = z.infer<typeof paperReviewSessionStateSchema>;

const fallbackStates = new Map<string, PaperReviewSessionState>();
registerOpeningPrivacyCleanup(() => fallbackStates.clear());

function createInitialState(now = new Date().toISOString()): PaperReviewSessionState {
  return {
    version: 1,
    roundNumber: 1,
    updatedAt: now,
    items: {},
  };
}

/** Build the account-, workspace-, and scope-isolated sessionStorage key. */
export function buildPaperReviewStorageKey(
  identity: SessionIdentity,
  scope: PaperReviewScope,
): string {
  return `${PAPER_REVIEW_STORAGE_PREFIX}:${identity.id}:${identity.workspaceId}:${scope.kind}:${scope.id}`;
}

function getSafeSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Read and validate persisted paper review state for the verified session identity. */
export function readPaperReviewSessionState(
  scope: PaperReviewScope,
  identity: SessionIdentity | null = getVerifiedSessionIdentity(),
): { state: PaperReviewSessionState; persisted: boolean } {
  if (!identity) {
    return { state: createInitialState(), persisted: false };
  }
  const key = buildPaperReviewStorageKey(identity, scope);
  const fallback = fallbackStates.get(key);
  if (fallback) return { state: fallback, persisted: false };
  const storage = getSafeSessionStorage();
  if (!storage) return { state: createInitialState(), persisted: false };
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return { state: createInitialState(), persisted: true };
    }
    const parsedJson: unknown = JSON.parse(raw);
    const parsed = paperReviewSessionStateSchema.safeParse(parsedJson);
    if (!parsed.success) {
      try {
        storage.removeItem(key);
      } catch {
        // Ignore storage cleanup error.
      }
      return { state: createInitialState(), persisted: true };
    }
    return { state: parsed.data, persisted: true };
  } catch {
    return { state: createInitialState(), persisted: false };
  }
}

/** Persist paper review state to sessionStorage only when a verified session identity exists. */
export function writePaperReviewSessionState(
  scope: PaperReviewScope,
  state: PaperReviewSessionState,
  identity: SessionIdentity | null = getVerifiedSessionIdentity(),
): boolean {
  if (!identity) return false;
  const parsed = paperReviewSessionStateSchema.safeParse(state);
  if (!parsed.success) return false;
  const key = buildPaperReviewStorageKey(identity, scope);
  try {
    const storage = getSafeSessionStorage();
    if (storage) {
      storage.setItem(key, JSON.stringify(parsed.data));
      fallbackStates.delete(key);
      return true;
    }
  } catch {
    // Preserve the newer value for other views of this scope.
  }
  fallbackStates.set(key, parsed.data);
  return false;
}

/** Remove all paper review session entries for the given identity (or all paper review keys when identity is omitted). */
export function clearPaperReviewSessionStorage(identity?: SessionIdentity | null): void {
  const prefix = identity
    ? `${PAPER_REVIEW_STORAGE_PREFIX}:${identity.id}:${identity.workspaceId}:`
    : `${PAPER_REVIEW_STORAGE_PREFIX}:`;
  for (const key of fallbackStates.keys()) {
    if (key.startsWith(prefix)) fallbackStates.delete(key);
  }
  const storage = getSafeSessionStorage();
  if (!storage) return;
  try {
    const keysToDelete: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      storage.removeItem(key);
    }
  } catch {
    // Ignore storage failures.
  }
}

/** Prune marked entries whose requirement is missing or whose revision no longer matches. */
export function pruneStalePaperReviewItems(
  state: PaperReviewSessionState,
  requirements: readonly PaperReviewRequirementRef[],
  now = new Date().toISOString(),
): { state: PaperReviewSessionState; prunedCount: number } {
  const revisionById = new Map<string, number>();
  for (const req of requirements) {
    revisionById.set(req.id, req.revision);
  }
  const nextItems: Record<string, PaperReviewItem> = {};
  let prunedCount = 0;
  for (const [reqId, item] of Object.entries(state.items)) {
    const currentRevision = revisionById.get(reqId);
    if (currentRevision === undefined || currentRevision !== item.requirementRevision) {
      prunedCount += 1;
      continue;
    }
    nextItems[reqId] = item;
  }
  if (prunedCount === 0) {
    return { state, prunedCount: 0 };
  }
  return {
    state: {
      ...state,
      updatedAt: now,
      items: nextItems,
    },
    prunedCount,
  };
}

const scopeListeners = new Map<string, Set<() => void>>();

function notifyScopeKey(key: string): void {
  const listeners = scopeListeners.get(key);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribeScopeKey(key: string, listener: () => void): () => void {
  let set = scopeListeners.get(key);
  if (!set) {
    set = new Set();
    scopeListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) {
      scopeListeners.delete(key);
    }
  };
}

export type PaperReviewSessionHandle = {
  roundNumber: number;
  markedIds: ReadonlySet<string>;
  markedCount: number;
  canUndo: boolean;
  storageAvailable: boolean;
  isMarked: (requirementId: string, expectedRevision?: number) => boolean;
  toggle: (requirementId: string, requirementRevision: number) => void;
  undo: () => void;
  startNextRound: () => void;
};

/**
 * Session-scoped cross-page checklist for "本轮纸上已复习".
 * Purely local to sessionStorage (never persisted to server, never counts as online independent evidence).
 */
export function usePaperReviewSession(
  scope: PaperReviewScope | null,
  requirements?: readonly PaperReviewRequirementRef[],
): PaperReviewSessionHandle {
  const scopeKind = scope?.kind ?? null;
  const scopeId = scope?.id ?? null;

  const activeScope = useMemo<PaperReviewScope | null>(
    () => (scopeKind && scopeId ? { kind: scopeKind, id: scopeId } : null),
    [scopeKind, scopeId],
  );
  const [hydrated, setHydrated] = useState(false);
  const [loaded, setLoaded] = useState<{
    key: string;
    state: PaperReviewSessionState;
    persisted: boolean;
  } | null>(null);
  const [undoEntry, setUndoEntry] = useState<{ key: string; state: PaperReviewSessionState } | null>(null);
  const identity = hydrated ? getVerifiedSessionIdentity() : null;
  const scopeKey = activeScope && hydrated
    ? identity
      ? buildPaperReviewStorageKey(identity, activeScope)
      : JSON.stringify([activeScope.kind, activeScope.id])
    : null;
  const emptyState = useMemo(() => createInitialState(), []);
  const active = loaded !== null && loaded.key === scopeKey ? loaded : null;
  const unpruned = active?.state ?? emptyState;
  const state = useMemo(
    () => requirements ? pruneStalePaperReviewItems(unpruned, requirements).state : unpruned,
    [requirements, unpruned],
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const undoSnapshot = useMemo(() => {
    if (!undoEntry || undoEntry.key !== scopeKey) return null;
    return requirements ? pruneStalePaperReviewItems(undoEntry.state, requirements).state : undoEntry.state;
  }, [requirements, scopeKey, undoEntry]);

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (!activeScope || !scopeKey) return;
    const load = () => setLoaded({
      key: scopeKey,
      ...readPaperReviewSessionState(activeScope),
    });
    load();
    setUndoEntry(null);
    const unsubscribeScope = subscribeScopeKey(scopeKey, load);
    const unsubscribePrivacy = subscribeOpeningPrivacyChange(() => {
      setUndoEntry(null);
      load();
    });
    return () => {
      unsubscribeScope();
      unsubscribePrivacy();
    };
  }, [activeScope, scopeKey]);

  const save = useCallback((next: PaperReviewSessionState) => {
    if (!activeScope || !scopeKey || !active) return false;
    const currentIdentity = getVerifiedSessionIdentity();
    const currentKey = currentIdentity
      ? buildPaperReviewStorageKey(currentIdentity, activeScope)
      : JSON.stringify([activeScope.kind, activeScope.id]);
    if (currentKey !== scopeKey) return false;
    stateRef.current = next;
    if (currentIdentity) {
      writePaperReviewSessionState(activeScope, next, currentIdentity);
      notifyScopeKey(scopeKey);
    } else {
      setLoaded({ key: scopeKey, state: next, persisted: false });
    }
    return true;
  }, [active, activeScope, scopeKey]);

  useEffect(() => {
    if (active && state !== unpruned) save(state);
  }, [active, save, state, unpruned]);

  useEffect(() => {
    if (undoEntry && undoSnapshot && undoEntry.state !== undoSnapshot) {
      setUndoEntry({ key: undoEntry.key, state: undoSnapshot });
    }
  }, [undoEntry, undoSnapshot]);

  const commit = useCallback(
    (next: PaperReviewSessionState, previousForUndo: PaperReviewSessionState | null) => {
      if (scopeKey && save(next)) {
        setUndoEntry(previousForUndo ? { key: scopeKey, state: previousForUndo } : null);
      }
    },
    [save, scopeKey],
  );

  const toggle = useCallback(
    (requirementId: string, requirementRevision: number) => {
      if (!Number.isInteger(requirementRevision) || requirementRevision <= 0 ||
        (requirements && !requirements.some(req => req.id === requirementId && req.revision === requirementRevision))) return;
      const prev = stateRef.current;
      const now = new Date().toISOString();
      const nextItems = { ...prev.items };
      const existing = nextItems[requirementId];
      if (existing && existing.requirementRevision === requirementRevision) {
        delete nextItems[requirementId];
      } else {
        nextItems[requirementId] = {
          requirementRevision,
          markedAt: now,
        };
      }
      commit(
        {
          version: 1,
          roundNumber: prev.roundNumber,
          updatedAt: now,
          items: nextItems,
        },
        prev,
      );
    },
    [commit, requirements],
  );

  const startNextRound = useCallback(() => {
    const prev = stateRef.current;
    if (Object.keys(prev.items).length === 0) return;
    const now = new Date().toISOString();
    commit(
      {
        version: 1,
        roundNumber: prev.roundNumber + 1,
        updatedAt: now,
        items: {},
      },
      prev,
    );
  }, [commit]);

  const undo = useCallback(() => {
    if (!undoSnapshot) return;
    commit(undoSnapshot, null);
  }, [commit, undoSnapshot]);

  const markedIds = useMemo(() => new Set(Object.keys(state.items)), [state.items]);

  const isMarked = useCallback(
    (requirementId: string, expectedRevision?: number) => {
      const entry = state.items[requirementId];
      if (!entry) return false;
      if (expectedRevision !== undefined) {
        return entry.requirementRevision === expectedRevision;
      }
      return true;
    },
    [state.items],
  );

  return {
    roundNumber: state.roundNumber,
    markedIds,
    markedCount: markedIds.size,
    canUndo: undoSnapshot !== null,
    storageAvailable: active?.persisted ?? false,
    isMarked,
    toggle,
    undo,
    startNextRound,
  };
}
