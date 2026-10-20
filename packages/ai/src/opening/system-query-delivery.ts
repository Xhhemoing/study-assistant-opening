import { systemQueryReceiptSchema, type SystemQueryReceipt, type SystemQueryResult } from "@aistudy/contracts";

/** Validate server data before release; never repair projections or ask the model to certify facts. */
export function validateSystemQueryDelivery(raw: SystemQueryReceipt): SystemQueryReceipt {
  const receipt = systemQueryReceiptSchema.parse(raw);
  const invalid = (result: SystemQueryResult): boolean => {
    if (result.status === "unknown" && result.data.length) return true;
    if (Date.parse(result.asOf) > Date.parse(receipt.asOf)) return true;
    for (const row of result.data) {
      for (const key of ["updatedAt", "submittedAt", "savedAt", "dataAsOf"] as const) {
        const value = (row as Record<string, unknown>)[key];
        if (typeof value === "string" && Date.parse(value) > Date.parse(result.asOf)) return true;
      }
    }
    if (result.name === "learning" && result.data.some(row => !row.projectionFresh
      || !["exact", "equivalent_confirmed"].includes(row.versionApplicability))) return true;
    if (result.name === "materials" && result.data.some(row => !result.sourceRefs.some(ref => ref.sourceId === row.sourceId && ref.sourceVersion === row.sourceVersion))) return true;
    if (result.name === "explain_decision" && result.status === "ok" && result.data.some(row => !row.current)) return true;
    if (result.name === "learner_state" && result.status === "ok" && result.data.some(row => row.completeness !== "complete")) return true;
    return false;
  };
  const results = receipt.results.map(result => invalid(result) ? { ...result, status: "unknown" as const, reason: "stale" as const,
    data: [], evidence: [], sourceRefs: [], nextOffset: null } as SystemQueryResult : result);
  const status = results.every(result => result.status === "unknown") ? "unknown"
    : results.some(result => result.status !== "ok") || receipt.status !== "ok" ? "partial" : "ok";
  return systemQueryReceiptSchema.parse({ ...receipt, results, status });
}
