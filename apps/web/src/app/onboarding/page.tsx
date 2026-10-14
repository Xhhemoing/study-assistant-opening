import { Onboarding } from "../../features/workspace/onboarding";
import { OpeningOnboardingView } from "../../features/opening/onboarding/onboarding-view";
import { isOpeningRelease } from "../../features/opening/access-policy";
export const dynamic = "force-dynamic";
export default function OnboardingPage() {
  return isOpeningRelease() ? <OpeningOnboardingView /> : <Onboarding />;
}
