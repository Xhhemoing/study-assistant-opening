import { ExplorationWorkspaceDetail } from "../../../../features/exploration/exploration-workspace";

export default async function ExplorationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExplorationWorkspaceDetail explorationId={id} />;
}
