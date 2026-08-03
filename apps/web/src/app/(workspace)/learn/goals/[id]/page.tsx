import { GoalDetail } from "../../../../../features/goals/goal-detail";

export default async function GoalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GoalDetail id={id} />;
}
