import { GoalWizard } from "../../../../../features/goals/goal-wizard";

export default async function NewGoalPage({
  searchParams,
}: {
  searchParams: Promise<{ courseId?: string }>;
}) {
  const { courseId } = await searchParams;
  return <GoalWizard courseId={courseId ?? null} />;
}
