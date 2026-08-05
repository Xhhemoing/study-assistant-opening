import { PromotionReview } from "../../../../../features/promotion-review/promotion-review";
export default async function PromotionReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PromotionReview explorationId={id} />;
}
