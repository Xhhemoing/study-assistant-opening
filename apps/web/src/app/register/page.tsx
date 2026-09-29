import { RegistrationView } from "../../features/auth/registration-view";
import { isOpeningRelease } from "../../features/opening/access-policy";

export default function RegisterPage() {
  return <RegistrationView registrationClosed={isOpeningRelease()} />;
}
