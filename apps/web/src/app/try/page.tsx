import { notFound } from "next/navigation";
import { allowsPublicTryChallenge, publicTryEntry } from "../../features/opening/access-policy";
import { ChallengeSheet } from "../../features/opening/public-try/challenge-sheet";

export const dynamic = "force-dynamic";
export const metadata = { title: "找出推导中的错步 · AIstudy" };

export default function PublicTryPage() {
  if (!allowsPublicTryChallenge()) notFound();
  return <ChallengeSheet entry={publicTryEntry()} />;
}
