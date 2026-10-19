import { expect, it, vi } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS, type SystemQueryAuthorization, type SystemQueryResult } from "@aistudy/contracts";
import { runSystemQuery } from "./system-query-agent";
const workspaceId = "00000000-0000-4000-8000-000000000001", principalId = "00000000-0000-4000-8000-000000000002";
const authorization: SystemQueryAuthorization = { purpose: "system_record_lookup", workspaceId, principalId, role: "workspace_owner", permissionRevision: `owner:${principalId}:privacy:0` };
it.each(["purpose", "workspaceId", "principalId", "permissionRevision"] as const)("rejects a reader result with a different %s before the planner sees it", async key => {
  const result = { name: "settings", authorization: { ...authorization, [key]: key === "purpose" ? "source_review" : key === "permissionRevision" ? "new-grant" : "00000000-0000-4000-8000-000000000003" },
    status: "ok", reason: "read", asOf: "2026-10-19T00:00:00Z", version: "1", evidence: [], sourceRefs: [], nextOffset: null,
    data: [{ ...DEFAULT_OPENING_AI_SETTINGS, taskRoutes: {}, savedAt: null, summary: "WRONG_SCOPE_DATA" }] } as SystemQueryResult;
  const output = { text: "", candidates: [], citedChunkIds: [], requestId: null, inputTokens: 0, outputTokens: 0 };
  const callModel = vi.fn().mockResolvedValueOnce({ ...output, toolCalls: [{ id: "c1", name: "settings", arguments: "{}" }] }).mockResolvedValueOnce(output);
  const receipt = await runSystemQuery({ authorization, privacyEpoch: 0, question: "设置？", assertCurrent: async () => {}, read: async () => result, callModel });
  expect(receipt.results[0]).toMatchObject({ status: "unknown", reason: "unavailable", data: [] });
  expect(JSON.stringify(callModel.mock.calls[1]![0])).not.toContain("WRONG_SCOPE_DATA");
});
