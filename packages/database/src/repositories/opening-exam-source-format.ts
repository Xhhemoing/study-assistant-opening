import type { ExamPack } from "@aistudy/contracts";

export const EXAM_DIRECTORY_FORMAT = "exam-sprint-directory-v1";
type Section = { lessonId: string | null; title: string; text: string };

/** Only syllabus metadata belongs in the ordinary course material. */
export function examPackDirectorySections(pack: ExamPack): Section[] {
  return [
    { lessonId: null, title: pack.title,
      text: `${pack.title}\n\n格式：${EXAM_DIRECTORY_FORMAT}\n题包：${pack.id}\n版本：${pack.version}\n\n${pack.description}\n\n${pack.limitations.join("\n")}` },
    ...pack.lessons.map(lesson => ({ lessonId: lesson.id, title: lesson.title,
      text: `${lesson.title}\n\n题包：${pack.id}\n版本：${pack.version}\n串讲：${lesson.id}\n主题：${lesson.topicId}\n\n${lesson.summary}` })),
  ];
}

/** Exact pre-directory serialization, used only to recognize retained historical originals. */
export function legacyExamPackSections(pack: ExamPack): Section[] {
  return [
    { lessonId: null, title: pack.title, text: `${pack.title}\n\n${pack.description}\n\n${pack.limitations.join("\n")}` },
    ...pack.lessons.map(lesson => ({ lessonId: lesson.id, title: lesson.title,
      text: `${lesson.title}\n\n${lesson.summary}\n\n${lesson.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n例题讲解\n${lesson.workedExample}\n\n易错点\n${lesson.pitfalls.join("\n")}` })),
  ];
}
