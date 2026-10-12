import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { listCardQueue } from "./cards-ops";

/**
 * PR-B: review queue "today" must be the workspace business day, not the UTC date.
 * Before the fix, cards-ops computed `today = now.toISOString().slice(0, 10)`, so
 * between Shanghai 00:00 and 07:59 a card whose maintainUntil was "yesterday"
 * still appeared in the auto queue. These cases fail on 07862cf and pass after.
 */
const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";
const cardId = "33333333-3333-4333-8333-333333333333";

function fakeSql(maintainUntil: string | null): Sql {
  const row = {
    id: cardId,
    owner_user_id: ownerUserId,
    front: "front",
    back: "back",
    source_document_id: null,
    syllabus_point_id: null,
    tags: [],
    archived: false,
    content_version: 1,
    paused_until: null,
    maintain_until: maintainUntil,
    exclude_from_assessment: false,
    created_at: "2026-10-01T00:00:00.000Z",
    ease: 2.5,
    interval_days: 1,
    due_at: "2026-10-10T00:00:00.000Z",
    reps: 1,
    lapses: 0,
    last_grade: "good",
    state_updated_at: "2026-10-10T00:00:00.000Z",
    state_owner_user_id: ownerUserId,
    goal_priority: 0,
  };
  return ((..._args: unknown[]) => Promise.resolve([row])) as unknown as Sql;
}

async function autoQueueIds(now: string, timeZone?: string | null, today?: string) {
  const entries = await listCardQueue(fakeSql("2026-10-12"), {
    workspaceId,
    ownerUserId,
    mode: "auto",
    now: new Date(now),
    ...(timeZone !== undefined ? { timeZone } : {}),
    ...(today ? { today } : {}),
  });
  return entries.map((entry) => entry.card.id);
}

describe("listCardQueue local business day (maintainUntil = 2026-10-12)", () => {
  it("Shanghai 2026-10-13 00:30 (UTC 10-12 16:30) is already the 13th → expired card excluded", async () => {
    expect(await autoQueueIds("2026-10-12T16:30:00.000Z", "Asia/Shanghai")).toEqual([]);
  });

  it("Shanghai 2026-10-13 07:59 (UTC 10-12 23:59) → excluded", async () => {
    expect(await autoQueueIds("2026-10-12T23:59:00.000Z", "Asia/Shanghai")).toEqual([]);
  });

  it("Shanghai 2026-10-13 08:00 (UTC 10-13 00:00) → excluded", async () => {
    expect(await autoQueueIds("2026-10-13T00:00:00.000Z", "Asia/Shanghai")).toEqual([]);
  });

  it("Shanghai 2026-10-12 23:59:59.999 is still the 12th → included; 00:00:00.000 is the 13th → excluded", async () => {
    expect(await autoQueueIds("2026-10-12T15:59:59.999Z", "Asia/Shanghai")).toEqual([cardId]);
    expect(await autoQueueIds("2026-10-12T16:00:00.000Z", "Asia/Shanghai")).toEqual([]);
  });

  it("missing / blank zone defaults to Asia/Shanghai (not UTC)", async () => {
    expect(await autoQueueIds("2026-10-12T16:30:00.000Z")).toEqual([]);
    expect(await autoQueueIds("2026-10-12T16:30:00.000Z", null)).toEqual([]);
    expect(await autoQueueIds("2026-10-12T16:30:00.000Z", "  ")).toEqual([]);
  });

  it("a UTC workspace keeps the UTC day (no +8h hack)", async () => {
    expect(await autoQueueIds("2026-10-12T16:30:00.000Z", "UTC")).toEqual([cardId]);
  });

  it("explicit today still wins", async () => {
    expect(await autoQueueIds("2026-10-12T16:30:00.000Z", "Asia/Shanghai", "2026-10-12")).toEqual([cardId]);
  });

  it("invalid time zone fails explicitly instead of falling back", async () => {
    await expect(autoQueueIds("2026-10-12T16:30:00.000Z", "Mars/Olympus_Mons")).rejects.toBeInstanceOf(RangeError);
  });

  it("result does not depend on the process TZ", async () => {
    const original = process.env.TZ;
    const outputs: string[][] = [];
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Asia/Shanghai", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        outputs.push(await autoQueueIds("2026-10-12T16:30:00.000Z", "Asia/Shanghai"));
        outputs.push(await autoQueueIds("2026-10-12T15:59:59.999Z", "Asia/Shanghai"));
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    for (let i = 0; i < outputs.length; i += 2) {
      expect(outputs[i]).toEqual([]);
      expect(outputs[i + 1]).toEqual([cardId]);
    }
  });
});
