import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS } from "@aistudy/contracts";
const mocks = vi.hoisted(() => ({ get: vi.fn(), local: vi.fn(), model: vi.fn(), epoch: vi.fn(), excluded: vi.fn(), gateway: {}, budget: {} }));
vi.mock("@aistudy/database", async original => ({ ...await original<typeof import("@aistudy/database")>(),
  createOpeningAiSettingsRepository: () => ({ get: mocks.get }),
}));
vi.mock("./model-gateway", () => ({ createDbModelGateway: () => mocks.gateway, scopeBudget: () => mocks.budget }));
vi.mock("../parsers/transcribe-adapter", () => ({ createPythonTranscribeAdapter: () => mocks.local }));
vi.mock("../parsers/model-transcribe-adapter", () => ({ createModelTranscribeAdapter: mocks.model }));
import { createMediaTranscribeWorkerDeps } from "./media-transcribe-wiring";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const job = { id: "job", ...scope, privacyEpoch: 3 } as never;
const adapter = vi.fn();
function deps() {
  return createMediaTranscribeWorkerDeps({} as never, { budget: {} as never,
    privacy: { getWorkspaceEpoch: mocks.epoch, isSourceExcluded: mocks.excluded } });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ settings: DEFAULT_OPENING_AI_SETTINGS, invalidStoredSettings: false });
  mocks.epoch.mockResolvedValue(3);
  mocks.excluded.mockResolvedValue(false);
  mocks.model.mockReturnValue(adapter);
});

describe("workspace media transcription wiring", () => {
  it("defaults old workspaces to local transcription, and reads the engine afresh per job", async () => {
    const wiring = deps();
    expect(await wiring.resolveTranscribe!(scope, job, "source")).toBe(mocks.local);
    mocks.get.mockResolvedValue({ settings: { ...DEFAULT_OPENING_AI_SETTINGS, transcription: { engine: "model" } }, invalidStoredSettings: false });
    expect(await wiring.resolveTranscribe!(scope, job, "source")).toBe(adapter);
    expect(mocks.model).toHaveBeenCalledWith({ scope, jobId: "job", gateway: mocks.gateway, budget: mocks.budget, beforeSend: expect.any(Function) });
    await mocks.model.mock.calls[0]![0].beforeSend();
    expect(mocks.excluded).toHaveBeenCalledWith(scope, "source");
  });

  it("refuses invalid saved preferences instead of silently changing engine", async () => {
    mocks.get.mockResolvedValue({ settings: DEFAULT_OPENING_AI_SETTINGS, invalidStoredSettings: true });
    await expect(deps().resolveTranscribe!(scope, job, "source")).rejects.toThrow("重新保存");
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it.each(["epoch", "excluded"])("blocks sending/publishing after the %s privacy fence changes", async (change) => {
    const wiring = deps();
    await expect(wiring.assertPrivacyCurrent!(scope, job, "source")).resolves.toBeUndefined();
    if (change === "epoch") mocks.epoch.mockResolvedValue(4);
    else mocks.excluded.mockResolvedValue(true);
    await expect(wiring.assertPrivacyCurrent!(scope, job, "source")).rejects.toThrow("privacy settings changed");
  });
});
