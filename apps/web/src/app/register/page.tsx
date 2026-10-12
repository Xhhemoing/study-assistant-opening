import { RegistrationView } from "../../features/auth/registration-view";
import { isOpeningRelease } from "../../features/opening/access-policy";

// PR-H: OPENING_RELEASE is a server switch read per request; static prerender would bake
// the build machine's value into the image (same image must differ per environment).
export const dynamic = "force-dynamic";

export default function RegisterPage() {
  return <RegistrationView registrationClosed={isOpeningRelease()} />;
}
