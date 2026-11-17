import { beforeEach, expect, it, vi } from "vitest";
import { TEACHING_EXAMPLE_CONSENT_VERSION } from "@aistudy/contracts";
const stubs = vi.hoisted(() => ({ context: vi.fn(), existing: vi.fn(), request: vi.fn(), read: vi.fn(), find: vi.fn(), resolve: vi.fn(), resolveFallback: vi.fn(), check: vi.fn() }));
vi.mock("@aistudy/database", () => ({ createOpeningTeachingExamplesRepository: () => stubs, checkOpeningBudgetAvailable: stubs.check }));
vi.mock("../../../../../worker/src/runtime/model-gateway", () => ({ createDbModelGateway: () => stubs }));
vi.mock("@aistudy/config", () => ({ loadOpeningModelCatalog: () => ({ dailyCapCents: 10, dailyQuotaMode: "limited" }) }));
import { createTeachingExampleService } from "./teaching-example-service";
const id = "11111111-1111-4111-8111-111111111111", scope = { workspaceId: id, ownerUserId: id };
const target = { activityId: id, documentId: id, blockId: id, revisionNumber: 1, contentVersion: 1 };
const request = { target, clientKey: "example-01", consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, acceptPaidGeneration: true };
beforeEach(() => {
  vi.clearAllMocks(); stubs.existing.mockResolvedValue(null); stubs.context.mockResolvedValue({ originalExample: "求导数 $x^2$，得 $2x$。" });
  stubs.resolve.mockResolvedValue({ modelSnapshot: { id: "synthetic", providerId: "synthetic", modelName: "synthetic", inputCentsPerMillion: 1, outputCentsPerMillion: 1 }, inputCentsPerMillion: 1, outputCentsPerMillion: 1 });
  stubs.resolveFallback.mockResolvedValue(null); stubs.check.mockResolvedValue({ allowed: true }); stubs.request.mockResolvedValue({ state: "queued" });
});
it("returns an advisory estimate and checks live budget without enqueuing", async () => {
  const result = await createTeachingExampleService({} as never).estimate(scope, target);
  expect(result).toMatchObject({ target, isCap: false, estimatedCents: 1 });
  expect(stubs.context).toHaveBeenCalledWith(scope, target); expect(stubs.check).toHaveBeenCalledOnce(); expect(stubs.request).not.toHaveBeenCalled();
});
it("replays an existing operation without needing an available model or sending again", async () => {
  stubs.existing.mockResolvedValue({ state: "outcome_unknown" }); stubs.resolve.mockRejectedValue(new Error("no model"));
  expect(await createTeachingExampleService({} as never).request(scope, request)).toEqual({ state: "outcome_unknown" });
  expect(stubs.resolve).not.toHaveBeenCalled(); expect(stubs.request).not.toHaveBeenCalled();
});
it("rejects unavailable estimation and exhausted budget before creating any operation", async () => {
  stubs.resolve.mockRejectedValueOnce(new Error("no model"));
  await expect(createTeachingExampleService({} as never).request(scope, request)).rejects.toThrow("不可预估");
  expect(stubs.request).not.toHaveBeenCalled();
  stubs.check.mockResolvedValue({ allowed: false });
  await expect(createTeachingExampleService({} as never).request(scope, request)).rejects.toThrow("预算"); expect(stubs.request).not.toHaveBeenCalled();
});
it("passes only the server-priced request after consent and live admission", async () => {
  await createTeachingExampleService({} as never).request(scope, request);
  expect(stubs.request).toHaveBeenCalledWith(scope, request, 1);
});
