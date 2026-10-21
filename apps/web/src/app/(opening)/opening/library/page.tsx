import { redirect } from "next/navigation";
import { LibraryView } from "../../../../features/opening/library/library-view";
import { parseSourceViewerSearchParams } from "../../../../features/opening/inbox/source-viewer";

export default async function OpeningLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; courseId?: string; source?: string; version?: string; page?: string; startMs?: string; slide?: string }>;
}) {
  const params = await searchParams;
  const { tab, courseId } = params;
  if (tab === "review") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
    query.set("tab", "memory");
    redirect(`/opening/suggestions?${query}`);
  }
  const initialOpen = parseSourceViewerSearchParams(params);
  return <LibraryView tab={tab} courseId={courseId} initialOpen={initialOpen} />;
}
