import { coachPlanAcceptInputSchema, coachPlanAcceptResultSchema, coachPlanAcceptanceSchema, coachPlanUndoInputSchema, coachPlanUndoResultSchema,
  type CoachPlanAcceptInput, type CoachPlanUndoInput } from "@aistudy/contracts";
import { OpeningApiError } from "./api";

export function createOpeningCoachClient(fetchImpl: typeof fetch = fetch) {
  async function request(path: string, body?: unknown) {
    const response = await fetchImpl(path, body === undefined ? { method: "GET" }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = result && typeof result === "object" && "error" in result ? result.error : null;
      throw new OpeningApiError(response.status, error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message : "教练安排暂时无法处理，请重新读取。");
    }
    return result;
  }
  return {
    async acceptCoachPlan(input: CoachPlanAcceptInput) {
      return coachPlanAcceptResultSchema.parse(await request("/api/opening/plans/coach/accept", coachPlanAcceptInputSchema.parse(input)));
    },
    async undoCoachPlan(input: CoachPlanUndoInput) {
      return coachPlanUndoResultSchema.parse(await request("/api/opening/plans/coach/undo", coachPlanUndoInputSchema.parse(input)));
    },
    async getCoachAcceptance(date: string) {
      return coachPlanAcceptanceSchema.nullable().parse(await request(`/api/opening/plans/coach?${new URLSearchParams({ date })}`));
    },
  };
}
