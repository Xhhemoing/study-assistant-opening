import { isOpeningRelease } from "../features/opening/access-policy";
import { redirect } from "next/navigation";
import { RootRedirect } from "../features/workspace/root-redirect";

export default function HomePage() {
  if (isOpeningRelease()) {
    redirect("/opening/today");
  }
  return <RootRedirect />;
}
