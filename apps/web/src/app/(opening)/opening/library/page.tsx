import { LibraryView } from "../../../../features/opening/library/library-view";

export default async function OpeningLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; courseId?: string }>;
}) {
  const { tab, courseId } = await searchParams;
  return <LibraryView tab={tab} courseId={courseId} />;
}
