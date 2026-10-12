import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS } from "@aistudy/contracts";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  catalog: vi.fn(),
  getSettings: vi.fn(),
  listModels: vi.fn(),
  getPlanning: vi.fn(),
}));

vi.mock("../../../../features/opening/runtime", () => ({
  requireOpeningScope: mocks.scope,
}));

vi.mock("@aistudy/config", async importOriginal => ({
  ...await importOriginal<typeof import("@aistudy/config")>(),
  loadOpeningModelCatalog: mocks.catalog,
}));

vi.mock("@aistudy/database", async importOriginal => ({
  ...await importOriginal<typeof import("@aistudy/database")>(),
  createOpeningAiSettingsRepository: () => ({ get: mocks.getSettings }),
  createOpeningModelProvidersRepository: () => ({ listResolvableModels: mocks.listModels }),
  createOpeningPlanningSettingsRepository: () => ({ get: mocks.getPlanning }),
}));

import { ApiError } from "../../../../features/auth/service";
import { GET } from "./route";

const secretKey = "sk-never-leak-this-key";
const secretEndpoint = "https://private-endpoint.example/v1";
const model = {
  id: "one",
  providerId: "p",
  providerLabel: "P",
  modelName: "opaque-model",
  label: "One",
  baseUrl: secretEndpoint,
  apiKey: secretKey,
  inputCentsPerMillion: 10,
  outputCentsPerMillion: 20,
  availability: "available" as const,
  supportsVision: false,
};
const scope = { workspaceId: "w", ownerUserId: "u" };

function createSqlMock() {
  return async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const q = strings.join("?");
    if (q.includes("sum(amount_cents)")) return [{ used: 0 }];
    if (q.includes("24 hours")) return [{ n: 0 }];
    if (q.includes("stale_pending") || q.includes("opening_outbox")) {
      return [{ stale_pending: 0, stale_queued: 0, failed_outbox: 0 }];
    }
    return [];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({ sql: createSqlMock(), scope });
  mocks.catalog.mockReturnValue({ models: [model], defaultModelId: "one", dailyCapCents: 0 });
  mocks.getSettings.mockResolvedValue({
    settings: DEFAULT_OPENING_AI_SETTINGS,
    saved: false,
    invalidStoredSettings: false,
  });
  mocks.listModels.mockResolvedValue([]);
  mocks.getPlanning.mockResolvedValue({
    settings: { timeZone: "Asia/Shanghai" },
    saved: true,
    invalidStoredSettings: false,
  });
  delete process.env.PARSER_OCR_MODEL_DIR;
});

describe("AI readiness HTTP boundary", () => {
  it("requires authentication before reading readiness", async () => {
    mocks.scope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "Authentication required", 401));
    const response = await GET(new Request("http://localhost/api/opening/ai-readiness"));
    expect(response.status).toBe(401);
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });

  it("returns 200 items shape with Cache-Control no-store and no secrets", async () => {
    mocks.catalog.mockReturnValue({ models: [model], defaultModelId: "one", dailyCapCents: 500 });
    const response = await GET(new Request("http://localhost/api/opening/ai-readiness"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item).toEqual(expect.objectContaining({
        key: expect.any(String),
        ok: expect.any(Boolean),
        detail: expect.any(String),
      }));
    }
    const text = JSON.stringify(body);
    expect(text).not.toContain(secretKey);
    expect(text).not.toContain(secretEndpoint);
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("sk-");
  });

  it("marks daily_budget failed when effective cap is disabled (env 0, unconfirmed)", async () => {
    mocks.catalog.mockReturnValue({ models: [model], defaultModelId: "one", dailyCapCents: 0 });
    mocks.getSettings.mockResolvedValue({
      settings: { ...DEFAULT_OPENING_AI_SETTINGS, dailyCapCents: null, budgetConfirmedAt: null },
      saved: false,
      invalidStoredSettings: false,
    });
    const response = await GET(new Request("http://localhost/api/opening/ai-readiness"));
    expect(response.status).toBe(200);
    const body = await response.json();
    const daily = body.items.find((item: { key: string }) => item.key === "daily_budget");
    expect(daily).toBeDefined();
    expect(daily.ok).toBe(false);
    const text = JSON.stringify(body);
    expect(text).not.toContain(secretKey);
    expect(text).not.toContain(secretEndpoint);
  });
});