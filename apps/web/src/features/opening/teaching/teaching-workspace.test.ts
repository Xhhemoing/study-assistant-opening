import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./preference-controls", () => ({
  PreferenceControls: () => createElement("div", { "data-testid": "session-intervention-prefs" }),
}));

vi.mock("./block-commands", async () => {
  const actual = await vi.importActual<typeof import("./block-commands")>("./block-commands");
  return {
    ...actual,
    BlockCommands: (props: { blockId: string; returnDisabled: boolean }) =>
      createElement("div", {
        "data-testid": "block-commands-mock",
        "data-block-id": props.blockId,
        "data-return-disabled": String(props.returnDisabled),
      }),
  };
});

vi.mock("./resume-card", async () => {
  const actual = await vi.importActual<typeof import("./resume-card")>("./resume-card");
  return {
    ...actual,
    ResumeCard: (props: {
      activity: { id: string; intentSummary: string };
      resume?: { activityId: string; clientInit: unknown } | null;
      onContinue?: (resume: unknown) => void;
    }) =>
      createElement(
        "div",
        {
          "data-testid": "resume-card-mock",
          "data-activity-id": props.activity.id,
          "data-has-resume": props.resume ? "true" : "false",
        },
        createElement(
          "button",
          {
            type: "button",
            "data-resume-continue-cta": "true",
            onClick: () => props.onContinue?.(props.resume),
          },
          "继续学习",
        ),
      ),
  };
});

import type { ActivitySpecClientInit, LearningResume, TeachingActivity } from "@aistudy/contracts";
import {
  isTeachingWorkspaceContentUsable,
  TeachingContinueEntry,
  TeachingWorkspace,
} from "./teaching-workspace";

const AID = "11111111-1111-4111-8111-111111111111";
const WID = "22222222-2222-4222-8222-222222222222";
const OID = "33333333-3333-4333-8333-333333333333";
const BID = "44444444-4444-4444-8444-444444444444";
const BID2 = "55555555-5555-4555-8555-555555555555";
const DOC = "66666666-6666-4666-8666-666666666666";
const UNIT = "77777777-7777-4777-8777-777777777777";
const SPEC = "88888888-8888-4888-8888-888888888888";
const ISO = "2026-10-11T04:00:00.000Z";

const activityReady: TeachingActivity = {
  id: AID,
  workspaceId: WID,
  ownerUserId: OID,
  courseId: null,
  status: "active",
  generateStatus: "ready",
  intentKind: "topic",
  intentSummary: "今日主题学习",
  sourceIds: [],
  pathVersion: 1,
  contentVersion: 1,
  clientKey: "today-topic:2026-10-11",
  createdAt: ISO,
  updatedAt: ISO,
};

function clientInit(overrides?: Partial<ActivitySpecClientInit>): ActivitySpecClientInit {
  return {
    id: SPEC,
    activityId: AID,
    teachingUnitId: UNIT,
    documentId: DOC,
    revisionNumber: 1,
    blockOrder: [
      { blockId: BID, position: 0, blockType: "text", role: "teach" },
      { blockId: BID2, position: 1, blockType: "answer_key", role: "answer_key" },
    ],
    sourceRefs: [],
    goals: [{ goalId: "g1", statement: "理解矩阵秩" }],
    verificationStatus: "structure_ok",
    generationConfig: {},
    version: 1,
    createdAt: ISO,
    updatedAt: ISO,
    blocks: [
      {
        blockId: BID,
        position: 0,
        blockType: "text",
        role: "teach",
        content: { text: "矩阵的秩表示线性无关行的最大个数。" },
      },
      {
        blockId: BID2,
        position: 1,
        blockType: "answer_key",
        role: "answer_key",
        content: null,
        answerRef: { refId: BID2, revealState: "hidden" },
      },
    ],
    contentVersion: 1,
    checkpointJson: {},
    ...overrides,
  };
}

describe("isTeachingWorkspaceContentUsable", () => {
  it("requires generateStatus ready and non-empty blocks", () => {
    expect(isTeachingWorkspaceContentUsable(activityReady, clientInit())).toBe(true);
    expect(
      isTeachingWorkspaceContentUsable(
        { ...activityReady, generateStatus: "queued" },
        clientInit(),
      ),
    ).toBe(false);
    expect(isTeachingWorkspaceContentUsable(activityReady, null)).toBe(false);
    expect(
      isTeachingWorkspaceContentUsable(activityReady, clientInit({ blocks: [] })),
    ).toBe(false);
  });
});

describe("TeachingWorkspace", () => {
  it("renders ordered blocks, expandable cites, prefs, and block command chrome", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingWorkspace, {
        activity: activityReady,
        clientInit: clientInit(),
        assistantHref: "/opening/assistant?conversation=x",
      }),
    );
    expect(html).toContain("data-teaching-workspace=\"true\"");
    expect(html).toContain("当前 AI 教学");
    expect(html).toContain("矩阵的秩");
    expect(html).toContain("data-block-fail-soft=\"answer_hidden\"");
    expect(html).toContain("提纲（按需展开）");
    expect(html).toContain("原材料 / 引用");
    expect(html).toContain("打开自由对话（次要）");
    expect(html).toContain("本课介入偏好（临时 · 按需展开）");
    expect(html).toContain('data-expand="intervention-prefs"');
    expect(html).toContain('data-testid="block-commands-mock"');
    expect(html).toContain(`data-block-id="${BID}"`);
    expect(html).toContain('data-return-disabled="true"');
    expect(html).toContain('data-content-version="1"');
    expect(html).toContain('data-path-version="1"');
    expect(html).not.toContain("AssistantView");
    expect(html).not.toContain("MediaReader");
  });

  it("enables return when checkpoint branchStack non-empty", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingWorkspace, {
        activity: activityReady,
        clientInit: clientInit({
          checkpointJson: {
            branchStack: [
              {
                frameId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                fromBlockId: BID,
                contentVersion: 1,
                pathVersion: 1,
                createdAt: ISO,
              },
            ],
          },
        }),
      }),
    );
    expect(html).toContain('data-return-disabled="false"');
  });

  it("fail-soft banner on unknown schema version without crashing (C4)", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingWorkspace, {
        activity: activityReady,
        clientInit: clientInit({
          generationConfig: { extras: { schemaVersion: "999" } },
        }),
      }),
    );
    expect(html).toContain("data-workspace-schema-fail=\"true\"");
    expect(html).toContain("schema 版本不受支持");
  });
});

function learningResume(overrides?: Partial<LearningResume>): LearningResume {
  return {
    activityId: AID,
    status: "active",
    generateStatus: "ready",
    contentVersion: 1,
    pathVersion: 1,
    clientInit: clientInit(),
    thoughtTrain: {
      currentBlockId: BID,
      skippedBlockIds: [],
      branchStack: [],
      commandLog: [],
    },
    drafts: [],
    interactionParams: {},
    actualAttempts: [],
    helpDelivered: [],
    openProblems: [],
    gates: {
      permission: "owned",
      materials: "available",
      unavailableSourceIds: [],
      job: "ready",
    },
    continuableActions: ["continue_block"],
    summary: { status: "skipped" },
    ...overrides,
  };
}

describe("TeachingContinueEntry", () => {
  it("starts on resume-card (not ConversationResume)", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingContinueEntry, {
        activity: activityReady,
        resume: learningResume({ clientInit: null }),
      }),
    );
    expect(html).toContain('data-teaching-continue-entry="card"');
    expect(html).toContain('data-testid="resume-card-mock"');
    expect(html).not.toContain("ConversationResume");
    expect(html).not.toContain("data-teaching-workspace");
  });

  it("can open workspace immediately when startInWorkspace + usable init", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingContinueEntry, {
        activity: activityReady,
        resume: learningResume(),
        startInWorkspace: true,
        initialClientInit: clientInit(),
      }),
    );
    expect(html).toContain('data-teaching-continue-entry="workspace"');
    expect(html).toContain('data-teaching-workspace="true"');
    expect(html).toContain('data-testid="block-commands-mock"');
    expect(html).toContain("本课介入偏好");
  });

  it("preserves V2-10/11/12 chrome when in workspace phase", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingContinueEntry, {
        activity: activityReady,
        startInWorkspace: true,
        initialClientInit: clientInit({
          checkpointJson: {
            branchStack: [
              {
                frameId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                fromBlockId: BID,
                contentVersion: 1,
                pathVersion: 1,
                createdAt: ISO,
              },
            ],
          },
        }),
      }),
    );
    expect(html).toContain('data-return-disabled="false"');
    expect(html).toContain('data-expand="intervention-prefs"');
    expect(html).toContain("打开自由对话（次要）");
  });
});

