import { notFound } from "next/navigation";

export default async function ReviewPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  } else {
    const { ReviewSession } = await import("../../../../features/review/review-session");
    return <ReviewSession />;
  }
}
