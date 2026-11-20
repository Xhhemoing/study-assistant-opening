// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { notifyOpeningPrivacyChange } from "../client/privacy-change";
import {
  buildPaperReviewStorageKey,
  clearPaperReviewSessionStorage,
  pruneStalePaperReviewItems,
  readPaperReviewSessionState,
  usePaperReviewSession,
  writePaperReviewSessionState,
} from "./paper-review-session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const activeRoots: { root: Root; container: HTMLDivElement }[] = [];

function renderHook<T>(useValue: () => T) {
  const result = { current: undefined as unknown as T };
  function Probe() {
    result.current = useValue();
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push({ root, container });
  act(() => {
    root.render(createElement(Probe));
  });
  return { result, rerender: () => act(() => root.render(createElement(Probe))) };
}

const ID_A = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" };
const ID_B = { id: "22222222-2222-4222-8222-222222222222", workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2" };
const COURSE_1 = "33333333-3333-4333-8333-333333333331";
const REQ_1 = "55555555-5555-4555-8555-555555555551";
const REQ_2 = "55555555-5555-4555-8555-555555555552";

describe("paper-review-session", () => {
  let disposeIdentity: (() => void) | null = null;

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    disposeIdentity = publishVerifiedSessionIdentity(ID_A);
  });

  afterEach(() => {
    while (activeRoots.length > 0) {
      const entry = activeRoots.pop()!;
      act(() => {
        entry.root.unmount();
      });
      entry.container.remove();
    }
    disposeIdentity?.();
    disposeIdentity = null;
    vi.restoreAllMocks();
  });

  it("isolates storage in sessionStorage by userId, workspaceId, and scope without touching localStorage", () => {
    const scope = { kind: "course" as const, id: COURSE_1 };
    const keyA = buildPaperReviewStorageKey(ID_A, scope);
    const keyB = buildPaperReviewStorageKey(ID_B, scope);
    expect(keyA).toBe(`aistudy:paper-review:v1:${ID_A.id}:${ID_A.workspaceId}:course:${COURSE_1}`);
    expect(keyA).not.toBe(keyB);

    const written = writePaperReviewSessionState(
      scope,
      {
        version: 1,
        roundNumber: 2,
        updatedAt: "2026-11-19T00:00:00.000Z",
        items: {
          [REQ_1]: { requirementRevision: 3, markedAt: "2026-11-19T00:00:00.000Z" },
        },
      },
      ID_A,
    );
    expect(written).toBe(true);
    expect(window.sessionStorage.getItem(keyA)).toBeTruthy();
    expect(window.localStorage.length).toBe(0);

    // Other user/workspace sees clean state.
    const other = readPaperReviewSessionState(scope, ID_B);
    expect(other.state.roundNumber).toBe(1);
    expect(other.state.items).toEqual({});
  });

  it("rejects malformed or extra-field payloads from sessionStorage and cleans them up", () => {
    const scope = { kind: "course" as const, id: COURSE_1 };
    const key = buildPaperReviewStorageKey(ID_A, scope);
    window.sessionStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        roundNumber: 1,
        updatedAt: "2026-11-19T00:00:00.000Z",
        items: {},
        injected: true,
      }),
    );

    const read = readPaperReviewSessionState(scope, ID_A);
    expect(read.state.roundNumber).toBe(1);
    expect(read.state.items).toEqual({});
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it("prunes stale entries whose requirement is missing or revision changed", () => {
    const { state, prunedCount } = pruneStalePaperReviewItems(
      {
        version: 1,
        roundNumber: 1,
        updatedAt: "2026-11-19T00:00:00.000Z",
        items: {
          [REQ_1]: { requirementRevision: 2, markedAt: "2026-11-19T00:00:00.000Z" },
          [REQ_2]: { requirementRevision: 1, markedAt: "2026-11-19T00:00:00.000Z" },
        },
      },
      [{ id: REQ_1, revision: 2 }],
    );
    expect(prunedCount).toBe(1);
    expect(Object.keys(state.items)).toEqual([REQ_1]);

    const drifted = pruneStalePaperReviewItems(state, [{ id: REQ_1, revision: 3 }]);
    expect(drifted.prunedCount).toBe(1);
    expect(drifted.state.items).toEqual({});
  });

  it("supports toggle, single-step undo, startNextRound, cross-hook sync, and clears on privacy change", () => {
    const scope = { kind: "course" as const, id: COURSE_1 };
    const reqs = [
      { id: REQ_1, revision: 4 },
      { id: REQ_2, revision: 2 },
    ];

    const mapHook = renderHook(() => usePaperReviewSession(scope, reqs));
    const sprintHook = renderHook(() => usePaperReviewSession(scope, reqs));

    act(() => {
      mapHook.result.current.toggle(REQ_1, 4);
    });
    expect(mapHook.result.current.markedCount).toBe(1);
    expect(mapHook.result.current.isMarked(REQ_1, 4)).toBe(true);
    expect(mapHook.result.current.isMarked(REQ_1, 5)).toBe(false);
    // Cross-page / cross-component sync within same tab:
    expect(sprintHook.result.current.markedCount).toBe(1);
    expect(sprintHook.result.current.isMarked(REQ_1, 4)).toBe(true);

    // Undo restores previous state.
    expect(mapHook.result.current.canUndo).toBe(true);
    act(() => {
      mapHook.result.current.undo();
    });
    expect(mapHook.result.current.markedCount).toBe(0);
    expect(sprintHook.result.current.markedCount).toBe(0);
    expect(mapHook.result.current.canUndo).toBe(false);

    // Mark again, then start next round.
    act(() => {
      mapHook.result.current.toggle(REQ_1, 4);
    });
    act(() => {
      mapHook.result.current.startNextRound();
    });
    expect(mapHook.result.current.roundNumber).toBe(2);
    expect(mapHook.result.current.markedCount).toBe(0);
    expect(sprintHook.result.current.roundNumber).toBe(2);

    // Undo startNextRound brings back round 1 and marked item.
    act(() => {
      mapHook.result.current.undo();
    });
    expect(mapHook.result.current.roundNumber).toBe(1);
    expect(mapHook.result.current.markedCount).toBe(1);

    // Privacy change clears stored session state and resets both hooks.
    act(() => {
      notifyOpeningPrivacyChange();
    });
    expect(mapHook.result.current.roundNumber).toBe(1);
    expect(mapHook.result.current.markedCount).toBe(0);
    expect(sprintHook.result.current.markedCount).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("keeps failed writes across views and prunes undo before a changed revision can reappear", () => {
    const scope = { kind: "course" as const, id: COURSE_1 };
    const refs = [{ id: REQ_1, revision: 1 }];
    let currentRefs = refs;
    const mounted = renderHook(() => usePaperReviewSession(scope, currentRefs));
    const other = renderHook(() => usePaperReviewSession(scope, refs));
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      act(() => mounted.result.current.toggle(REQ_1, 1));
      expect(mounted.result.current.markedCount).toBe(1);
      expect(other.result.current.markedCount).toBe(1);
      expect(mounted.result.current.storageAvailable).toBe(false);
      expect(other.result.current.storageAvailable).toBe(false);

      act(() => mounted.result.current.startNextRound());
      currentRefs = [{ id: REQ_1, revision: 2 }];
      mounted.rerender();
      act(() => mounted.result.current.undo());
      expect(readPaperReviewSessionState(scope).state.items).toEqual({});
      expect(mounted.result.current.markedCount).toBe(0);
      expect(mounted.result.current.storageAvailable).toBe(false);
      act(() => notifyOpeningPrivacyChange());
      expect(readPaperReviewSessionState(scope).persisted).toBe(true);
    } finally {
      storage.mockRestore();
    }
  });

  it("clears review and sandbox storage when the corresponding views are unmounted", () => {
    const key = buildPaperReviewStorageKey(ID_A, { kind: "course", id: COURSE_1 });
    window.sessionStorage.setItem(key, "{}");
    window.localStorage.setItem("aistudy/free-map/geometry/course", "{}");
    window.localStorage.setItem("aistudy-series-example-comparison-check-v1", "{}");
    window.localStorage.setItem("aistudy-unrelated", "keep");
    notifyOpeningPrivacyChange();
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(window.localStorage.getItem("aistudy/free-map/geometry/course")).toBeNull();
    expect(window.localStorage.getItem("aistudy-series-example-comparison-check-v1")).toBeNull();
    expect(window.localStorage.getItem("aistudy-unrelated")).toBe("keep");
  });

  it("degrades gracefully without writing to sessionStorage when identity is missing or storage throws", () => {
    disposeIdentity?.();
    disposeIdentity = null;

    const scope = { kind: "course" as const, id: COURSE_1 };
    const { result } = renderHook(() => usePaperReviewSession(scope));
    expect(result.current.storageAvailable).toBe(false);

    act(() => {
      result.current.toggle(REQ_1, 1);
    });
    expect(result.current.markedCount).toBe(1);
    expect(window.sessionStorage.length).toBe(0);

    // Also test storage error resilience when identity IS present.
    disposeIdentity = publishVerifiedSessionIdentity(ID_A);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    const ok = writePaperReviewSessionState(
      scope,
      {
        version: 1,
        roundNumber: 1,
        updatedAt: "2026-11-19T00:00:00.000Z",
        items: {},
      },
      ID_A,
    );
    expect(ok).toBe(false);
    clearPaperReviewSessionStorage(ID_A);
  });
});
