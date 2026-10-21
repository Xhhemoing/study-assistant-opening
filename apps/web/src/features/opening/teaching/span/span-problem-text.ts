import type { SpanProblem } from "@aistudy/contracts";
import { spanProblemStem } from "@aistudy/domain";

/** Both versions preserve the catalog's membership, witness and consistency requirements. */
export function spanProblemText(problem: SpanProblem): { english: string; chinese: string } {
  const vector = (values: string[]) => `(${values.join(", ")})`;
  return { chinese: spanProblemStem(problem),
    english: `Given v=${vector(problem.vectors[0])}, w=${vector(problem.vectors[1])}, and u=${vector(problem.target)}, determine whether u belongs to span{v,w}. If it does, give any pair of coefficients satisfying αv+βw=u and check every coordinate. If it does not, explain why the system is inconsistent.` };
}
