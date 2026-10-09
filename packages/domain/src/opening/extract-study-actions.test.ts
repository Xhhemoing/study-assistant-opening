import { describe, expect, it } from "vitest";
import {
  extractStudyActionCandidates,
  resolveCandidateDueAt,
} from "./extract-study-actions";

const TZ = "Asia/Shanghai";
const SOURCE = "00000000-0000-4000-8000-0000000000s1";
const RECEIPT = "00000000-0000-4000-8000-0000000000r1";

describe("resolveCandidateDueAt", () => {
  it("parses absolute ISO dates in the owner timezone", () => {
    const resolved = resolveCandidateDueAt({
      text: "作业截止 2026-10-20 提交",
      sentAt: "2026-10-09T01:00:00.000Z",
      timeZone: TZ,
    });
    expect(resolved.needsConfirmation).toBe(false);
    expect(resolved.dueAt).toMatch(/^2026-10-20/);
  });

  it("flags relative week without sentAt for confirmation", () => {
    expect(
      resolveCandidateDueAt({
        text: "下周交作业",
        sentAt: null,
        timeZone: TZ,
      }),
    ).toMatchObject({
      dueAt: null,
      needsConfirmation: true,
      confirmationReason: "relative_date_missing_sent_at",
    });
  });

  it("flags forwarded mail for confirmation and clears dueAt", () => {
    expect(
      resolveCandidateDueAt({
        text: "作业截止 2026-10-20",
        sentAt: "2026-10-09T01:00:00.000Z",
        timeZone: TZ,
        isForward: true,
      }),
    ).toMatchObject({
      dueAt: null,
      needsConfirmation: true,
      confirmationReason: "forwarded_notice",
    });
  });

  it("does not treat missing sync time as a due date", () => {
    // No sentAt, no absolute date → no invented due from "now".
    expect(
      resolveCandidateDueAt({
        text: "请交作业",
        sentAt: null,
        timeZone: TZ,
      }),
    ).toMatchObject({ dueAt: null, needsConfirmation: true });
  });
});

describe("extractStudyActionCandidates", () => {
  it("emits only pending candidates (never accepted)", () => {
    const candidates = extractStudyActionCandidates(
      [
        {
          sourceId: SOURCE,
          receiptId: RECEIPT,
          text: "高等数学作业截止 2026-10-20\n请提交 PDF",
          sentAt: "2026-10-09T08:00:00.000Z",
          channel: "mail",
        },
      ],
      {
        timeZone: TZ,
        createId: () => "11111111-1111-4111-8111-111111111111",
      },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      status: "pending",
      needsConfirmation: false,
      sourceIds: [SOURCE],
      dedupeKey: expect.stringContaining(RECEIPT),
    });
    expect(candidates[0]!.status).not.toBe("accepted");
  });

  it("marks forward notices as needing confirmation", () => {
    const candidates = extractStudyActionCandidates(
      [
        {
          sourceId: SOURCE,
          receiptId: RECEIPT,
          text: "Fwd: 作业提醒",
          sentAt: "2026-10-09T08:00:00.000Z",
          isForward: true,
          channel: "mail",
        },
      ],
      { timeZone: TZ, createId: () => "11111111-1111-4111-8111-111111111111" },
    );
    expect(candidates[0]?.needsConfirmation).toBe(true);
    expect(candidates[0]?.dueAt).toBeNull();
  });

  it("skips non-study chatter", () => {
    expect(
      extractStudyActionCandidates(
        [
          {
            sourceId: SOURCE,
            receiptId: RECEIPT,
            text: "今晚一起吃饭吗？",
            sentAt: "2026-10-09T08:00:00.000Z",
          },
        ],
        { timeZone: TZ },
      ),
    ).toEqual([]);
  });
});
