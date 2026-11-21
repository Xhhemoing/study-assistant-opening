import { allowsPublicTryChallenge } from "../../../features/opening/access-policy";
import { InvalidShareCard } from "../../../features/opening/share/share-card";

export default function SharePitfallNotFound() {
  return <InvalidShareCard tryAvailable={allowsPublicTryChallenge()} />;
}
