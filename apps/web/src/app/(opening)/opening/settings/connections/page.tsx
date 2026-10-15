import { ConnectionSettings } from "../../../../../features/opening/connections/connection-settings";
import { PageHeading } from "../../../../../features/opening/design/ui";
import Link from "next/link";

export default function OpeningConnectionsSettingsPage() {
  return (
    <main className="flex h-full min-h-0 flex-col bg-white text-zinc-800">
      <PageHeading
        title="数据连接"
        description="管理学校邮箱与钉钉授权。"
        action={
          <Link
            href="/opening/today"
            className="text-xs text-zinc-600 underline decoration-zinc-300 underline-offset-4 hover:text-zinc-900"
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
    </main>
  );
}
