import { ConversationObjectFrame } from "../../../../features/opening/assistant/conversation-object-frame";
import { ReviewHub } from "../../../../features/opening/review/review-hub";
import { readReviewTab, type ReviewSearch } from "../../../../features/opening/review/review-route";

export default async function OpeningReviewPage({ searchParams }: { searchParams: Promise<ReviewSearch> }) {
  const search = await searchParams;
  return <ConversationObjectFrame conversation={search.conversation}><ReviewHub initialTab={readReviewTab(search.tab)} /></ConversationObjectFrame>;
}
