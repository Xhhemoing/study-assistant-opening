import { redirect } from "next/navigation";
import { uuidSchema } from "@aistudy/contracts";
import { LibraryView } from "../../../../features/opening/library/library-view";
import { parseSourceViewerSearchParams } from "../../../../features/opening/inbox/source-viewer";

export default async function OpeningLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; courseId?: string; source?: string; version?: string; page?: string; startMs?: string; slide?: string; conversation?: string }>;
}) {
  const params = await searchParams;
  const { tab, courseId } = params;
  if (tab === "review") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
    query.set("tab", "memory");
    redirect(`/opening/suggestions?${query}`);
  }
  if (tab === "map") {
    const parsedCourseId = uuidSchema.safeParse(courseId);
    if (parsedCourseId.success) {
      redirect(`/opening/map?context=course&id=course/${parsedCourseId.data}`);
    }
    redirect("/opening/map");
  }
  const initialOpen = parseSourceViewerSearchParams(params);
  return <LibraryView tab={tab} courseId={courseId} initialOpen={initialOpen} />;
}
