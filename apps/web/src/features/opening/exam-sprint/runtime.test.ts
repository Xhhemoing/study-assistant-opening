import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  quota: { maxBytes: 1234, maxObjects: 3 },
  repository: { bind: vi.fn() },
  createRepository: vi.fn(),
  putObject: vi.fn().mockResolvedValue(undefined),
  finalKey: vi.fn((sourceId: string, version: number) => `opening/sources/${sourceId}/v${version}`),
}));
vi.mock("@aistudy/database", () => ({
  createOpeningExamIntegrationRepository: deps.createRepository,
  createOpeningBudgetRepository: vi.fn(), createOpeningExamSprintRepository: vi.fn(),
  createOpeningExamForecastRepository: vi.fn(), createOpeningExamReviewsRepository: vi.fn(),
}));
vi.mock("@aistudy/config", () => ({ loadOpeningUploadQuota: () => deps.quota, loadOpeningModelCatalog: vi.fn() }));
vi.mock("../../../../../worker/src/runtime/model-gateway", () => ({ createDbModelGateway: vi.fn(), scopeBudget: vi.fn() }));
vi.mock("../../../../../worker/src/runtime/source-page-images", () => ({
  createSourcePageImages: vi.fn(), openingPageStorage: () => ({ finalKey: deps.finalKey, putObject: deps.putObject }),
}));
vi.mock("./review-service", () => ({ createExamPhotoReviewService: vi.fn() }));

import { getExamIntegrationService } from "./runtime";

describe("exam integration runtime upload quota", () => {
  it("passes configured quota to admissions and writes the original bytes to the final source key", async () => {
    deps.createRepository.mockReturnValue(deps.repository);
    const sql = {} as Sql;
    expect(getExamIntegrationService(sql)).toBe(deps.repository);
    const [passedSql, , options] = deps.createRepository.mock.calls[0]!;
    expect(passedSql).toBe(sql);
    expect(options.quota).toBe(deps.quota);
    const body = Buffer.from("公开串讲", "utf8");
    await options.writePublicSource({ sourceId: "public-source", version: 0, mime: "text/plain", body });
    expect(deps.finalKey).toHaveBeenCalledWith("public-source", 0);
    expect(deps.putObject).toHaveBeenCalledWith("opening/sources/public-source/v0", body, { mime: "text/plain" });
  });
});
