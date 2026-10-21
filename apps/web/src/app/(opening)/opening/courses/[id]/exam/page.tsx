import { headers } from "next/headers";
import { uuidSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { getCourseExamService } from "../../../../../../features/opening/exam-sprint/course-exam-runtime";
import { CourseExamView } from "../../../../../../features/opening/exam-sprint/course-exam-view";

export default async function CourseExamPage({ params }: { params: Promise<{ id: string }> }) {
  const courseId = uuidSchema.parse((await params).id);
  const request = new Request("http://opening.local/course-exam", { headers: await headers() });
  const { scope, sql } = await requireOpeningScope(request);
  return <CourseExamView initial={await getCourseExamService(sql).read(scope, courseId)} />;
}
