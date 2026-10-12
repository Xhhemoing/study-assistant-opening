import { isOpeningRelease } from "../features/opening/access-policy";
import { redirect } from "next/navigation";
import { RootRedirect } from "../features/workspace/root-redirect";

// PR-H: OPENING_RELEASE is a server switch read per request; static prerender would bake
// the build machine's value into the image (same image must differ per environment).
export const dynamic = "force-dynamic";

export default function HomePage() {
  if (isOpeningRelease()) {
    redirect("/opening/today");
  }
  return <RootRedirect />;
}
