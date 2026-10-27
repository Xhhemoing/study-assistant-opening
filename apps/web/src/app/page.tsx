import { isOpeningRelease } from "../features/opening/access-policy";
import { RootRedirect } from "../features/workspace/root-redirect";

// PR-H: OPENING_RELEASE is a server switch read per request; static prerender would bake
// the build machine's value into the image (same image must differ per environment).
export const dynamic = "force-dynamic";

/** 两种模式都按已保存的默认入口进入；release 未设置时进入助理。 */
export default function HomePage() {
  return <RootRedirect release={isOpeningRelease()} />;
}
