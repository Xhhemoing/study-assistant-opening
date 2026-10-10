import { LibraryView } from "../../../../features/opening/library/library-view";
import { parseSourceViewerSearchParams } from "../../../../features/opening/inbox/source-viewer";

export default async function OpeningLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; courseId?: string; source?: string; version?: string; page?: string; startMs?: string; slide?: string }>;
}) {
  const params = await searchParams;
  const { tab, courseId } = params;
  const initialOpen = parseSourceViewerSearchParams(params);
  return <LibraryView tab={tab} courseId={courseId} initialOpen={initialOpen} />;
}
