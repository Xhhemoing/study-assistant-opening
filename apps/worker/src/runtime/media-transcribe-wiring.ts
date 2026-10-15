import type { Sql } from "postgres";
import { createOpeningAiSettingsRepository, type OpeningBudgetRepository, type OpeningJobRecord, type OpeningPrivacyRepository } from "@aistudy/database";
import type { Scope } from "@aistudy/contracts";
import type { ParseMediaDeps } from "../jobs/parse-media";
import { createModelTranscribeAdapter } from "../parsers/model-transcribe-adapter";
import { createPythonTranscribeAdapter } from "../parsers/transcribe-adapter";
import { createDbModelGateway, scopeBudget } from "./model-gateway";

/** Resolve per workspace/job; changing one workspace never changes another's engine. */
export function createMediaTranscribeWorkerDeps(sql: Sql, shared: {
  budget: OpeningBudgetRepository;
  privacy: Pick<OpeningPrivacyRepository, "getWorkspaceEpoch" | "isSourceExcluded">;
}): Pick<ParseMediaDeps, "resolveTranscribe" | "assertPrivacyCurrent"> {
  const preferences = createOpeningAiSettingsRepository(sql);
  const gateway = createDbModelGateway(sql);
  const local = createPythonTranscribeAdapter();
  async function assertPrivacyCurrent(scope: Scope, job: OpeningJobRecord, sourceId: string) {
    const [epoch, excluded] = await Promise.all([
      shared.privacy.getWorkspaceEpoch(scope),
      shared.privacy.isSourceExcluded(scope, sourceId),
    ]);
    if (epoch !== job.privacyEpoch || excluded) throw new Error("media privacy settings changed; transcription discarded");
  }
  return {
    assertPrivacyCurrent,
    resolveTranscribe: async (scope, job, sourceId) => {
      const preference = await preferences.get(scope);
      if (preference.invalidStoredSettings) throw new Error("已保存的模型设置无效，请到设置重新保存。");
      if ((preference.settings.transcription?.engine ?? "local") === "local") return local;
      return createModelTranscribeAdapter({
        gateway, scope, budget: scopeBudget(shared.budget, scope), jobId: job.id,
        beforeSend: () => assertPrivacyCurrent(scope, job, sourceId),
      });
    },
  };
}
