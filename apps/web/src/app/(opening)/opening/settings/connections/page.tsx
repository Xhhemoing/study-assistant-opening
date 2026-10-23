import { ConnectionSettings } from "../../../../../features/opening/connections/connection-settings";
import { PageHeading, ui } from "../../../../../features/opening/design/ui";
import { TransitionLink as Link } from "../../../../../features/opening/v3/motion/view-transition";

export default function OpeningConnectionsSettingsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-text">
      <PageHeading
        title="数据连接"
        description="管理学校邮箱与钉钉授权。"
        action={
          <Link
            href="/opening/today"
            className={ui.quiet}
          >
            返回今日
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-5">
          <ConnectionSettings />
        </div>
      </div>
    </div>
  );
}
