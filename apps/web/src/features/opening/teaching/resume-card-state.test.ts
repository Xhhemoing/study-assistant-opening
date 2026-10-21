import { isValidElement, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningResume, TeachingActivity, TeachingDraftAnchor } from "@aistudy/contracts";

// Same dependency-aware hook harness as the nearby interaction tests, with
// Object.is state bailouts and a bounded render loop to catch effect cycles.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void>, dirty: false }));
vi.mock("react", async original => {
  const memo = (factory: () => unknown, deps: unknown[]) => {
    const i = hooks.cursor++, previous = hooks.values[i] as { value: unknown; deps: unknown[] } | undefined;
    if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.values[i] = { value: factory(), deps };
    return (hooks.values[i] as { value: unknown }).value;
  };
  return { ...await original<typeof import("react")>(),
    useState: (initial: unknown) => {
      const i = hooks.cursor++;
      if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[i], (next: unknown) => {
        const value = typeof next === "function" ? next(hooks.values[i]) : next;
        if (!Object.is(hooks.values[i], value)) { hooks.values[i] = value; hooks.dirty = true; }
      }];
    },
    useMemo: memo,
    useCallback: (value: unknown, deps: unknown[]) => memo(() => value, deps),
    useEffect: (effect: () => unknown, deps: unknown[]) => {
      const i = hooks.cursor++, previous = hooks.values[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
      if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.effects.push(() => {
        previous?.cleanup?.(); hooks.values[i] = { deps, cleanup: effect() };
      });
    },
  };
});
const api = vi.hoisted(() => ({ getTeachingResume: vi.fn(), postTeachingCheckpoint: vi.fn(), patchTeachingActivityStatus: vi.fn() }));
const createApi = vi.hoisted(() => vi.fn());
vi.mock("../client/api", () => ({ createOpeningApi: createApi }));
import { ResumeCard, ResumeCardView, type ResumeCardProps } from "./resume-card";

const id = "11111111-1111-4111-8111-111111111111";
const blockId = "22222222-2222-4222-8222-222222222222";
const activity: TeachingActivity = {
  id, workspaceId: id, ownerUserId: id, courseId: null, status: "active", generateStatus: "ready",
  intentKind: "topic", intentSummary: "学习单元", sourceIds: [], pathVersion: 1, contentVersion: 2,
  clientKey: "resume-test", createdAt: "2026-10-20T01:00:00.000Z", updatedAt: "2026-10-20T02:00:00.000Z",
};
function resume(activityId = id): LearningResume {
  return { activityId, status: "active", generateStatus: "ready", contentVersion: 2, pathVersion: 1, clientInit: null,
    thoughtTrain: { currentBlockId: blockId, skippedBlockIds: [], branchStack: [], commandLog: [] },
    drafts: [], interactionParams: {}, actualAttempts: [], helpDelivered: [], openProblems: [],
    gates: { permission: "owned", materials: "available", unavailableSourceIds: [], job: "ready" },
    continuableActions: ["continue_block"], summary: { status: "skipped" },
  };
}
function render(props: ResumeCardProps) {
  let count = 0;
  let tree: ReturnType<typeof ResumeCard>;
  do {
    if (++count > 10) throw new Error("ResumeCard did not settle within 10 renders");
    hooks.cursor = 0; hooks.dirty = false;
    tree = ResumeCard(props);
    hooks.effects.splice(0).forEach(effect => effect());
  } while (hooks.dirty);
  return { tree, count };
}
function view(props: ResumeCardProps) {
  const { tree } = render(props);
  expect(isValidElement(tree) && tree.type === ResumeCardView).toBe(true);
  return tree.props as ComponentProps<typeof ResumeCardView>;
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function unmount() { for (const value of hooks.values) (value as { cleanup?: () => void } | null)?.cleanup?.(); }
beforeEach(() => {
  hooks.values = []; hooks.effects = []; hooks.cursor = 0; hooks.dirty = false;
  vi.clearAllMocks(); createApi.mockImplementation(() => ({ ...api }));
  api.getTeachingResume.mockResolvedValue(resume());
  api.postTeachingCheckpoint.mockImplementation(async (activityId: string, input: { drafts: TeachingDraftAnchor[] }) => {
    api.getTeachingResume.mockResolvedValue({ ...resume(activityId), drafts: input.drafts });
    return { ok: true, contentVersion: 2, checkpointJson: {} };
  });
});
afterEach(unmount);

it("settles omitted defaults and parent rerenders without repeated requests", async () => {
  const p: ResumeCardProps = { activity };
  expect(render(p).count).toBeLessThan(5);
  await settle();
  expect(render(p).count).toBeLessThan(5);
  expect(view({ ...p, activity: { ...activity } }).localUnsent).toEqual([]);
  expect(api.getTeachingResume).toHaveBeenCalledTimes(1);
  expect(createApi).toHaveBeenCalledTimes(1);
});

it("reads new external drafts without mirroring them back on every render", () => {
  const p: ResumeCardProps = { activity, resume: resume(), localUnsent: [] };
  expect(render(p).count).toBeLessThan(5);
  p.localUnsent = [{ blockId, draftText: "new draft" }];
  expect(view(p).localUnsent).toEqual(p.localUnsent);
  expect(render({ ...p, localUnsent: [...p.localUnsent] }).count).toBeLessThan(5);
});

it("keeps a successful sync cleared through unrelated parent rerenders", async () => {
  const p: ResumeCardProps = { activity, resume: resume(), localUnsent: [{ blockId, draftText: "saved" }] };
  view(p).onSyncUnsent!(); await settle();
  expect(view(p).localUnsent).toEqual([]);
  expect(view({ ...p, localUnsent: [...p.localUnsent!] }).localUnsent).toEqual([]);
  expect(api.postTeachingCheckpoint).toHaveBeenCalledTimes(1);
});

it("does not discard edits made while an older draft is being saved", async () => {
  let complete!: (value: unknown) => void;
  api.postTeachingCheckpoint.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const p: ResumeCardProps = { activity, resume: resume(), localUnsent: [{ blockId, draftText: "old" }] };
  view(p).onSyncUnsent!();
  p.localUnsent = [{ blockId, draftText: "new" }];
  expect(view(p).localUnsent).toEqual(p.localUnsent);
  complete({ ok: true, contentVersion: 2, checkpointJson: {} }); await settle();
  expect(view(p).localUnsent).toEqual(p.localUnsent);
});

it.each(["anchor", "network"])("preserves %s conflict and local draft after rereading", async failure => {
  if (failure === "anchor") api.postTeachingCheckpoint.mockResolvedValueOnce({ ok: false, mismatch: "draft_anchor_lost", lostBlockIds: [blockId] });
  else api.postTeachingCheckpoint.mockRejectedValueOnce(new Error("offline"));
  const p: ResumeCardProps = { activity, resume: resume(), localUnsent: [{ blockId, draftText: "keep me" }] };
  view(p).onSyncUnsent!(); await settle();
  expect(view(p).localUnsent).toEqual(p.localUnsent);
  expect(view(p).conflict?.kind).toBe(failure === "anchor" ? "draft_anchor_lost" : "version_conflict");
  expect(api.getTeachingResume).toHaveBeenCalledTimes(1);
});

it("does not hide identical unsent text in a different activity", async () => {
  const p: ResumeCardProps = { activity, resume: resume(), localUnsent: [{ blockId, draftText: "saved" }] };
  view(p).onSyncUnsent!(); await settle();
  const other = "33333333-3333-4333-8333-333333333333";
  p.activity = { ...activity, id: other }; p.resume = resume(other);
  expect(view(p).localUnsent).toEqual(p.localUnsent);
});

it("ignores a save response after switching activities", async () => {
  let complete!: (value: unknown) => void;
  api.postTeachingCheckpoint.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const onResumeUpdated = vi.fn();
  const p: ResumeCardProps = { activity, resume: resume(), localUnsent: [{ blockId, draftText: "old activity" }], onResumeUpdated };
  view(p).onSyncUnsent!();
  const other = "33333333-3333-4333-8333-333333333333";
  p.activity = { ...activity, id: other }; p.resume = resume(other); p.localUnsent = [{ blockId, draftText: "new activity" }];
  expect(view(p).syncBusy).toBe(false);
  complete({ ok: true, contentVersion: 2, checkpointJson: {} }); await settle();
  expect(view(p).localUnsent).toEqual(p.localUnsent);
  expect(view(p).resume.activityId).toBe(other);
  expect(api.getTeachingResume).not.toHaveBeenCalled();
  expect(onResumeUpdated).not.toHaveBeenCalled();
});

it("does not publish an unmounted manual refresh", async () => {
  let complete!: (value: LearningResume) => void;
  api.getTeachingResume.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const onResumeUpdated = vi.fn();
  const p: ResumeCardProps = { activity, resume: resume(), onResumeUpdated };
  view(p).onReread!(); unmount();
  complete(resume()); await settle();
  expect(onResumeUpdated).not.toHaveBeenCalled();
});

it("clears acknowledged drafts only within the submitted content version", async () => {
  const p: ResumeCardProps = { activity, resume: resume(), localUnsent: [{ blockId, draftText: "same text", contentVersion: 2 }] };
  view(p).onSyncUnsent!(); await settle();
  p.localUnsent = [{ blockId, draftText: "same text", contentVersion: 3 }];
  expect(view(p).localUnsent).toEqual(p.localUnsent);
});


it("uses the submitted version when an unversioned draft is later shown in a new content version", async () => {
  const p: ResumeCardProps = { activity, resume: resume(), localUnsent: [{ blockId, draftText: "same text" }] };
  view(p).onSyncUnsent!(); await settle();
  expect(view(p).localUnsent).toEqual([]);
  expect(api.postTeachingCheckpoint).toHaveBeenCalledWith(id, {
    expectedVersion: 2, drafts: [{ blockId, draftText: "same text", contentVersion: 2 }],
  });
  p.resume = { ...resume(), contentVersion: 3, drafts: [{ blockId, draftText: "same text", contentVersion: 3 }] };
  expect(view(p).localUnsent).toEqual(p.localUnsent);
});

it("does not let a historical acknowledgement hide a new draft after the server draft changes", async () => {
  const p: ResumeCardProps = { activity, resume: resume(), localUnsent: [{ blockId, draftText: "X" }] };
  view(p).onSyncUnsent!(); await settle();
  expect(view(p).localUnsent).toEqual([]);
  p.localUnsent = [];
  p.resume = { ...resume(), drafts: [{ blockId, draftText: "Y", contentVersion: 2 }] };
  expect(view(p).localUnsent).toEqual([]);
  p.localUnsent = [{ blockId, draftText: "X" }];
  expect(view(p).localUnsent).toEqual(p.localUnsent);
});

it("keeps the local draft when the reread does not confirm the saved snapshot", async () => {
  api.postTeachingCheckpoint.mockResolvedValueOnce({ ok: true, contentVersion: 2, checkpointJson: {} });
  const p: ResumeCardProps = { activity, resume: resume(), localUnsent: [{ blockId, draftText: "X" }] };
  view(p).onSyncUnsent!(); await settle();
  expect(view(p).localUnsent).toEqual(p.localUnsent);
});
