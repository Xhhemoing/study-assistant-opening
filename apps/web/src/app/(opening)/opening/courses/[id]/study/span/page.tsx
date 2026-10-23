import { TransitionLink as Link } from "../../../../../../../features/opening/v3/motion/view-transition";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { uuidSchema, type StudySessionIntent } from "@aistudy/contracts";
import { loadCourseStudyContext } from "../../../../../../../features/courses/server/course-study-context";
import { SpanLessonSession } from "../../../../../../../features/opening/teaching/span/span-lesson-session";
import { createStudyIntentService } from "../../../../../../../features/opening/teaching/span/intent-service";
import { createSpanTeachingSequence, spanModeForIntent } from "@aistudy/domain";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
export default async function SpanLessonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ retest?: string; intentEvent?: string; move?: string; lesson?: string; conversation?: string }> }) {
  const { id } = await params;
  const { retest, intentEvent, lesson, conversation } = await searchParams;
  let { move } = await searchParams;
  const request = new Request("http://opening.local/courses/study/span", { headers: await headers() });
  const context = await loadCourseStudyContext(request, id);
  if (!context.teachingEnabled) return <section className="space-y-3 p-5"><h1 className="text-lg font-semibold">当前工作区尚未开放教学工作区</h1><p className="text-sm text-zinc-600">原课程记录保留，可返回课程继续普通练习或查看材料。</p><Link className="text-sm text-emerald-800 underline" href={`/opening/courses/${id}/study`}>返回课程学习</Link></section>;
  let initialNewEvidenceEventId: string | undefined;
  let initialIntent: StudySessionIntent | undefined;
  if (intentEvent) {
    if (!uuidSchema.safeParse(intentEvent).success) notFound();
    const { scope, sql } = await requireOpeningScope(request);
    const event = await createStudyIntentService(sql).forCourse(scope, intentEvent, id);
    if (!event) notFound();
    initialIntent = event.intent;
    if (event.signals.some(signal => signal === "guessed" || signal === "copied_answer")) initialNewEvidenceEventId = event.id;
    if (event.id !== intentEvent || !createSpanTeachingSequence(spanModeForIntent(event.intent)).some(candidate => candidate.id === move)) move = undefined;
  }
  return <SpanLessonSession key={`${id}:${retest ?? "study"}`} originalConversationId={conversation} initialActivityId={lesson} courseId={id} sourceIds={context.sourceIds} sourceLoadError={context.sourceLoadError} delayedRetestId={retest} initialIntent={initialIntent} initialMoveId={move} initialNewEvidenceEventId={initialNewEvidenceEventId} />;
}
