import { LibraryView } from "../../../../features/opening/library/library-view";

export default async function OpeningLibraryPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  return <LibraryView tab={tab} />;
}
