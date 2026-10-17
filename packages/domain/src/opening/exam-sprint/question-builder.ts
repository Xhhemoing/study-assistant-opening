import type { ExamQuestion } from "@aistudy/contracts";

export function question(
  id: string, topicId: string, skillId: string, familyId: string,
  pool: ExamQuestion["pool"], difficulty: ExamQuestion["difficulty"],
  prompt: string, labels: [string, string, string, string], answer: "A" | "B" | "C" | "D",
  hint: string, explanation: string,
): ExamQuestion {
  return {
    id, topicId, skillId, familyId, lessonId: skillId, pool, difficulty, prompt,
    options: labels.map((label, index) => ({ id: ["A", "B", "C", "D"][index]!, label })),
    answer, hint, explanation, estimatedMinutes: difficulty === "foundation" ? 2 : 3,
  };
}
