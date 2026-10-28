import { expect, it, vi } from "vitest";
import { createLongTermPlanningService } from "./long-term-service";
const scope = { workspaceId: "00000000-0000-4000-8000-000000000001", ownerUserId: "00000000-0000-4000-8000-000000000002" };
it("rejects a silent overwrite request before calling the repository", async () => {
  const command = vi.fn(), service = createLongTermPlanningService({ command } as never);
  await expect(service.command(scope, { action: "preview", overwriteAccepted: true })).rejects.toThrow();
  expect(command).not.toHaveBeenCalled();
});
it("passes original confirm intent once without inventing a retry key", async () => {
  const command = vi.fn(async () => ({ original: true })), service = createLongTermPlanningService({ command } as never);
  const request = { action: "confirm", draftId: scope.workspaceId, expectedBaseVersion: 3, clientKey: "original-unknown-key" };
  await service.command(scope, request);
  expect(command).toHaveBeenCalledExactlyOnceWith(scope, request);
});
