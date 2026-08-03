import { ExplorationThread } from "../../../../features/explore/exploration-thread";

export default async function ExplorationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExplorationThread explorationId={id} />;
}
