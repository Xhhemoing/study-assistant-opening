import { expect, it, vi } from "vitest";
import { createOpeningCoachClient } from "./coach-client";
import { OpeningApiError } from "./api";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
it("posts only validated coach intent and reads a scoped summary without writing", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("null", { status: 200 }));
  expect(await createOpeningCoachClient(fetcher).getCoachAcceptance("2026-10-21")).toBeNull();
  expect(fetcher).toHaveBeenCalledWith("/api/opening/plans/coach?date=2026-10-21", { method: "GET" });
  await expect(createOpeningCoachClient(fetcher).acceptCoachPlan({ draftId: id, expectedDraftVersion: 0, clientKey: "coach:user-intent",
    budgetMinutes: 999 } as never)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("preserves the exact undo version/key and rejects transport failures", async () => {
  const result = { acceptedVersion: 2, blocks: [], closedTaskIds: [id], replayed: false };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
  const input = { date: "2026-10-21", acceptanceClientKey: "coach:user-intent", expectedAcceptedVersion: 1, clientKey: "undo:user-intent" };
  expect(await createOpeningCoachClient(fetcher).undoCoachPlan(input)).toEqual(result);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(input);
  fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { message: "任务已开始" } }), { status: 409 }));
  await expect(createOpeningCoachClient(fetcher).undoCoachPlan(input)).rejects.toBeInstanceOf(OpeningApiError);
});
