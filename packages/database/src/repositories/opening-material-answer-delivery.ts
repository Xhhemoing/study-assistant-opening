import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { readMaterialAnswers } from "./opening-material-questions";
import { generateOpeningStudyExposure, releaseOpeningStudyExposure } from "./opening-study-exposure";

/** Read and exposure release share the classification/submission history lock.
 * Raw internal answer reads are also used by grading, which is NOT learner exposure. */
export async function deliverMaterialAnswers(sql: Sql, scope: Scope, attemptId: string) {
  return sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx,scope);
    const answers=await readMaterialAnswers(tx,scope,attemptId);
    if (answers.length) {
      const receipt=await generateOpeningStudyExposure(tx,scope,{
        releaseKey:`material-answer:${attemptId}`,contextAnchor:{attemptId,purpose:"history_solution"},
        origin:"history_solution",kind:"solution",level:"revealed",supportDomain:"math",
      });
      await releaseOpeningStudyExposure(tx,scope,receipt.id);
    }
    return answers;
  });
}
