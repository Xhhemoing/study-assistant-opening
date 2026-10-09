import { describe, expect, it, vi } from "vitest";
import { createExtractStudyActionsHandler } from "./extract-study-actions";

const job = {
  id: "00000000-0000-4000-8000-0000000000j1",
  workspaceId: "00000000-0000-4000-8000-0000000000w1",
  ownerUserId: "00000000-0000-4000-8000-0000000000u1",
  key: "extract:course",
  kind: "extract-study-actions",
  payload: {},
  result: null,
  state: "running" as const,
  privacyEpoch: 0,
};

const SOURCE = "00000000-0000-4000-8000-0000000000s1";
const RECEIPT = "00000000-0000-4000-8000-0000000000r1";
const COURSE = "00000000-0000-4000-8000-0000000000c1";

describe("createExtractStudyActionsHandler", () => {
  it("extracts pending homework candidates from authorized import chunks", async () => {
    const listAuthorizedImportChunks = vi.fn(async () => [
      {
        sourceId: SOURCE,
        receiptId: RECEIPT,
        text: "线性代数作业截止 2026-10-22\n请在课程平台提交",
        sentAt: "2026-10-09T02:00:00.000Z",
        channel: "mail",
      },
    ]);
    const process = createExtractStudyActionsHandler({ listAuthorizedImportChunks });
    const result = await process(job, {
      courseId: COURSE,
      timeZone: "Asia/Shanghai",
    });
    expect(listAuthorizedImportChunks).toHaveBeenCalledWith(
      { workspaceId: job.workspaceId, ownerUserId: job.ownerUserId },
      COURSE,
      undefined,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      status: "pending",
      sourceIds: [SOURCE],
      needsConfirmation: false,
    });
  });

  it("rejects missing courseId / timeZone", async () => {
    const process = createExtractStudyActionsHandler({
      listAuthorizedImportChunks: async () => [],
    });
    await expect(process(job, {})).rejects.toThrow(/courseId/);
    await expect(process(job, { courseId: COURSE })).rejects.toThrow(/timeZone/);
  });

  it("refuses injected extractors that emit accepted candidates", async () => {
    const process = createExtractStudyActionsHandler({
      listAuthorizedImportChunks: async () => [
        {
          sourceId: SOURCE,
          receiptId: RECEIPT,
          text: "作业",
          sentAt: null,
        },
      ],
      extract: () => [
        {
          id: "11111111-1111-4111-8111-111111111111",
          dedupeKey: "x",
          title: "作业",
          minutes: 30,
          dueAt: null,
          priority: 1,
          sourceIds: [SOURCE],
          status: "accepted",
          needsConfirmation: true,
        },
      ],
    });
    await expect(
      process(job, { courseId: COURSE, timeZone: "Asia/Shanghai" }),
    ).rejects.toThrow(/accepted/);
  });
});
