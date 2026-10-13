import { notFound } from "next/navigation";

export default async function GoalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  } else {
    const { id } = await params;
    const { GoalDetail } = await import("../../../../../features/goals/goal-detail");
    return <GoalDetail id={id} />;
  }
}
