import { diagnosticsSchema, type AttemptEvent } from "@aistudy/contracts";
import { getTodayPlan, listStatuses } from "./provider-plan";
import { readDomain, type MockProviderState } from "./provider-state";

export function getDiagnostics(state: MockProviderState) {
  const plan = getTodayPlan(state);
  return diagnosticsSchema.parse({
    versions: { provider: "mock-1", srs: "srs-1", assessment: "assess-1", planner: "plan-1" },
    recentAttemptEvents: readDomain<AttemptEvent[]>(state, "attemptEvents", []).slice(-10),
    statuses: listStatuses(state),
    planTaskReasons: plan.tasks.map((task) => ({ taskId: task.id, reason: task.reason })),
  });
}
