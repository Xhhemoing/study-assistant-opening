import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const diagnostics = vi.hoisted(() => ({ enabled: false }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => diagnostics.enabled }));
beforeEach(() => { diagnostics.enabled = false; });

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
    expect(jobGateBannerCopy("unknown")).toMatch(/无法确认/);
    expect(materialsGateBannerCopy("partial")).toMatch(/部分材料/);
  });
});

describe("ResumeCardView", () => {
  it("keeps learner status, saved content counts, gates and Continue without technical diagnostics", () => {
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
    expect(html).toContain("学习位置");
    expect(html).toContain("今日主题学习");
    expect(html).toContain('data-resume-client-init="null"');
    expect(html).toContain('data-resume-job-gate="in_flight"');
    expect(html).toContain('data-resume-materials-gate="partial"');
    expect(html).toContain("1 段内容已保存");
    expect(html).toContain("还有 1 道题可以继续");
    expect(html).not.toContain("data-resume-diagnostics");
    expect(html).not.toMatch(/命令日志|当前块|摘要状态|skipped|草稿为权威|attempt_open/);
    expect(html).toContain('data-resume-continue-cta="true"');
    expect(html).toContain("继续学习");
    expect(html).toContain('data-resume-pause="true"');
    expect(html).toContain('data-resume-reread="true"');
    expect(html).not.toContain("ConversationResume");
    expect(html).not.toContain("强制覆盖");
  });

  it("keeps full conflict contents and recovery controls available without diagnostics", () => {
    const original = "本次输入\n" + "完整内容".repeat(60) + "<script>保留结尾</script>";
    const saved = "已保存文字\n" + "早先内容".repeat(60) + "保存结尾";
    const unsent: LocalUnsentDraft[] = [{ blockId: BID2, draftText: original }];
    const html = renderToStaticMarkup(
      createElement(ResumeCardView, {
        activityTitle: "对照草稿",
        activityStatus: "paused",
        generateStatusLabel: "主讲内容已就绪",
        resume: resume({ status: "paused", drafts: [draft(BID, saved)] }),
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
    expect(html).toContain("1 段内容尚未保存");
    expect(html).toContain("本次未保存内容");
    expect(html).toContain(saved);
    expect(html).toContain(original.replace("<script>", "&lt;script&gt;").replace("</script>", "&lt;/script&gt;"));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("data-resume-diagnostics");
    expect(html).not.toContain("部分草稿锚点已失效");
    expect(html).toContain('data-resume-sync-unsent="true"');
    expect(html).toContain('data-resume-reread="true"');
    expect(html).toContain('data-resume-unpause="true"');
    expect(html).not.toContain("force overwrite");
    expect(html).toContain('data-forbid-lww="true"');
    expect(html).toContain("两侧内容不会自动覆盖");
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
    expect(html).toContain("暂时无法确认内容是否生成完成");
    expect(html).toContain("1 段内容已保存");
  });
  it("places technical state under the existing diagnostics switch in a closed disclosure", () => {
    diagnostics.enabled = true;
    const html = renderToStaticMarkup(createElement(ResumeCardView, {
      activityTitle: "学习", activityStatus: "active", generateStatusLabel: "主讲内容已就绪", resume: resume(),
    }));
    expect(html).toMatch(/<details[^>]*data-resume-diagnostics="true"/);
    expect(html).not.toMatch(/<details[^>]*open=/);
    expect(html).toContain("命令日志 1");
    expect(html).toContain("当前块");
    expect(html).toContain("attempt_open");
    expect(html).toContain("摘要状态：skipped");
    expect(html).toContain('data-draft-chip="server"');
    expect(html).toContain('data-continuable-action="command_return"');
  });

  it("retains unsaved content and save action even with no server content or conflict", () => {
    const html = renderToStaticMarkup(createElement(ResumeCardView, {
      activityTitle: "学习", activityStatus: "active", generateStatusLabel: "主讲内容已就绪", resume: resume({ drafts: [] }),
      localUnsent: [{ blockId: BID, draftText: "尚未保存的完整答案" }], onSyncUnsent: () => undefined,
    }));
    expect(html).toContain("1 段内容尚未保存");
    expect(html).toContain("尚未保存的完整答案");
    expect(html).toContain('data-resume-sync-unsent="true"');
    expect(html).not.toContain("data-resume-diagnostics");
  });

});
