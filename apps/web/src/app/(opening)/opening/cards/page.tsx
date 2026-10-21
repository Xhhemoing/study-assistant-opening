import { redirect } from "next/navigation";
import { legacyCardsHref, type ReviewSearch } from "../../../../features/opening/review/review-route";

export default async function OpeningCardsPage({ searchParams }: { searchParams: Promise<ReviewSearch> }) {
  redirect(legacyCardsHref(await searchParams));
}
