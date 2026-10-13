import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LearningResume, TeachingDraftAnchor } from "@aistudy/contracts";
import {
  checkpointConflictRequiresJuxtapose,
  continuableActionLabel,
  jobGateBannerCopy,
  materialsGateBannerCopy,
  ResumeCardView,
  resumeIgnoresSummary,
  summarizeThoughtTrain,
  type LocalUnsentDraft,
} from "./resume-card";

const AID = "11111111-1111-4111-8111-111111111111";
const BID = "44444444-4444-4444-8444-444444444444";
const BID2 = "55555555-5555-4555-8555-555555555555";
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ISO = "2026-10-11T04:00:00.000Z";

function draft(blockId: string, text: string): TeachingDraftAnchor {
  return { blockId, contentVersion: 2, draftText: text };
}

function resume(overrides?: Partial<LearningResume>): LearningResume {
  return {
    activityId: AID,
    status: "active",
    generateStatus: "ready",
    contentVersion: 2,
    pathVersion: 1,
    clientInit: null,
    thoughtTrain: {
      currentBlockId: BID,
      skippedBlockIds: [],
      branchStack: [
        {
          frameId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          fromBlockId: BID,
          contentVersion: 1,
          pathVersion: 1,
          createdAt: ISO,
        },
      ],
      commandLog: [
        {
          clientKey: "cmd-key-01",
          kind: "why",
          blockId: BID,
          at: ISO,
          result: "ok",
        },
      ],
    },
    drafts: [draft(BID, "服务端草稿正文")],
    interactionParams: {},
    actualAttempts: [],
    helpDelivered: [],
    openProblems: [
      { problemId: PID, itemVersionId: null, reason: "attempt_open" },
    ],
    gates: {
      permission: "owned",
      materials: "available",
      unavailableSourceIds: [],
      job: "ready",
    },
    continuableActions: [
      "continue_block",
      "edit_draft",
      "command_return",
      "command_why",
    ],
    summary: { status: "skipped" },
    ...overrides,
  };
}

describe("resume-card helpers", () => {
  it("summarizes thought train depth", () => {
    const s = summarizeThoughtTrain(resume());
    expect(s.branchDepth).toBe(1);
    expect(s.commandLogCount).toBe(1);
    expect(s.currentBlockId).toBe(BID);
  });

  it("resume path ignores summary (independence)", () => {
    expect(resumeIgnoresSummary(resume({ summary: { status: "skipped" } }))).toBe(true);
    expect(resumeIgnoresSummary(resume({ summary: { status: "failed" } }))).toBe(true);
    expect(resumeIgnoresSummary(resume({ summary: undefined }))).toBe(true);
  });

  it("checkpoint draft_anchor_lost requires juxtapose; never LWW", () => {
    expect(
      checkpointConflictRequiresJuxtapose({
        ok: false,
        mismatch: "draft_anchor_lost",
        lostBlockIds: [BID],
      }),
    ).toBe(true);
    expect(
      checkpointConflictRequiresJuxtapose({
        ok: true,
        contentVersion: 3,
        checkpointJson: {},
      }),
    ).toBe(false);
  });

  it("labels continuable actions and gate copy", () => {
    expect(continuableActionLabel("command_return")).toMatch(/返回/);
    expect(continuableActionLabel("wait_job")).toMatch(/等待/);
    expect(jobGateBannerCopy("unknown")).toMatch(/未知/);
    expect(materialsGateBannerCopy("partial")).toMatch(/部分材料/);
  });
});

describe("ResumeCardView", () => {
  it("renders title/status, thought depth, drafts, open problems, gates, Continue CTA", () => {
    const html = renderToStaticMarkup(
      createElement(ResumeCardView, {
        activityTitle: "今日主题学习",
        activityStatus: "active",
        generateStatusLabel: "主讲内容已就绪",
        resume: resume({
          gates: {
            permission: "owned",
            materials: "partial",
            unavailableSourceIds: [BID2],
            job: "in_flight",
          },
          continuableActions: ["continue_block", "wait_job", "resolve_material", "command_return"],
          clientInit: null,
        }),
        onContinue: () => undefined,
        onPause: () => undefined,
        onReread: () => undefined,
      }),
    );
    expect(html).toContain('data-teaching-resume-card="true"');
    expect(html).toContain("学习断点 · 继续");
    expect(html).toContain("今日主题学习");
    expect(html).toContain('data-resume-client-init="null"');
    expect(html).toContain('data-resume-job-gate="in_flight"');
    expect(html).toContain('data-resume-materials-gate="partial"');
    expect(html).toContain("data-resume-thought-train");
    expect(html).toContain("分支 1");
    expect(html).toContain("data-resume-open-problems");
    expect(html).toContain("attempt_open");
    expect(html).toContain('data-draft-chip="server"');
    expect(html).toContain('data-resume-continue-cta="true"');
    expect(html).toContain("继续学习");
    expect(html).toContain('data-continuable-action="wait_job"');
    expect(html).toContain('data-continuable-action="command_return"');
    expect(html).toContain("data-resume-summary-independence");
    expect(html).toContain("不依赖 AI 摘要");
    expect(html).not.toContain("ConversationResume");
    expect(html).not.toContain("强制覆盖");
  });

  it("juxtaposes server vs local unsent drafts; forbids LWW", () => {
    const unsent: LocalUnsentDraft[] = [
      { blockId: BID2, draftText: "本地未发送草稿" },
    ];
    const html = renderToStaticMarkup(
      createElement(ResumeCardView, {
        activityTitle: "对照草稿",
        activityStatus: "paused",
        generateStatusLabel: "主讲内容已就绪",
        resume: resume({ status: "paused" }),
        localUnsent: unsent,
        conflict: {
          kind: "draft_anchor_lost",
          lostBlockIds: [BID2],
          message: "部分草稿锚点已失效",
        },
        onContinue: () => undefined,
        onResumeStatus: () => undefined,
        onReread: () => undefined,
        onSyncUnsent: () => undefined,
      }),
    );
    expect(html).toContain('data-forbid-lww="true"');
    expect(html).toContain("data-resume-draft-juxtapose");
    expect(html).toContain('data-draft-chip="unsent"');
    expect(html).toContain("未发送");
    expect(html).toContain("服务端");
    expect(html).toContain("本地未发送");
    expect(html).toContain("禁止强制覆盖");
    expect(html).toContain('data-resume-unpause="true"');
    expect(html).not.toContain("force overwrite");
    expect(html).toContain('data-forbid-lww="true"');
    expect(html).toMatch(/禁止强制覆盖|禁止后写优先/);
  });

  it("shows fail-soft gate banners for unknown job without crashing", () => {
    const html = renderToStaticMarkup(
      createElement(ResumeCardView, {
        activityTitle: "未知生成",
        activityStatus: "active",
        generateStatusLabel: "生成状态未知",
        resume: resume({
          generateStatus: "unknown",
          gates: {
            permission: "owned",
            materials: "unavailable",
            unavailableSourceIds: [BID],
            job: "unknown",
          },
          continuableActions: ["wait_job", "resolve_material"],
          drafts: [draft(BID, "仍保留")],
        }),
        onContinue: () => undefined,
      }),
    );
    expect(html).toContain('data-resume-gate-job="unknown"');
    expect(html).toContain('data-resume-gate-materials="unavailable"');
    expect(html).toContain("不会假装已就绪");
    expect(html).toContain('data-draft-chip="server"');
  });
});
