import { discardReviewCandidate } from "../../../../../../features/opening/planning/review-discard-service";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return discardReviewCandidate(request, (await context.params).id, "retest");
}
