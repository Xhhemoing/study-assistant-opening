import { SuggestionsView } from "@/features/opening/planning/suggestions-view";

export default async function SuggestionsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  return <SuggestionsView tab={(await searchParams).tab} />;
}
