import type { Sql } from "postgres";
import { runSystemQuery, renderSystemQuery, type SystemQueryService, type SystemQueryPlanner } from "@aistudy/ai";
import { createScopedOpeningSystemQueryReader, readOpeningSystemQueryAuthorization, mergeContextSourceRefs } from "@aistudy/database";
import { loadFeatureSwitches } from "@aistudy/config";

/** Production defaults to finite rules. A trusted injected planner is admitted by the same engine;
 * this constructor never loads a catalog/key/provider. Live gateway wiring awaits C1/C2. */
export function createDbSystemQueryService(sql: Sql, process: "web" | "worker", options: { planner?: SystemQueryPlanner } = {}): SystemQueryService {
  const enabled = () => loadFeatureSwitches().systemQuery;
  return { enabled, async reply(scope, input, outerSignal) {
    if (!enabled()) throw new Error("系统记录查询暂未开启。");
    const controller = new AbortController(), abort = () => controller.abort();
    outerSignal?.addEventListener("abort", abort, { once: true });
    if (outerSignal?.aborted) abort();
    const timer = setTimeout(abort, 12000);
    try {
      const frame = await readOpeningSystemQueryAuthorization(sql, scope, "system_record_lookup", controller.signal);
      const assertCurrent = async () => {
        const current = await readOpeningSystemQueryAuthorization(sql, scope, "system_record_lookup", controller.signal);
        if (current.authorization.permissionRevision !== frame.authorization.permissionRevision) throw new Error("query permission changed");
      };
      const receipt = await runSystemQuery({ ...frame, question: input.question, focus: input.focus, signal: controller.signal, assertCurrent,
        callModel: options.planner,
        read: createScopedOpeningSystemQueryReader(sql, scope, { purpose: "system_record_lookup", publicSettings: () => {
          const flags = loadFeatureSwitches(); return { process, adaptivePlanning: flags.adaptivePlanning, teachingLoop: flags.teachingLoop.api };
        } }),
      });
      if (!options.planner) receipt.reason = "native_tools_not_enabled";
      await assertCurrent();
      if (controller.signal.aborted) throw new Error("system query cancelled");
      return { text: renderSystemQuery(receipt), receipt, privacyEpoch: frame.privacyEpoch,
        contextSourceRefs: mergeContextSourceRefs(...receipt.results.map(result => result.sourceRefs)) };
    } finally { clearTimeout(timer); outerSignal?.removeEventListener("abort", abort); }
  } };
}
