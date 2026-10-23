import Link from "next/link";
import { uuidSchema } from "@aistudy/contracts";
import { PhotoPractice } from "../../../../features/opening/learning/photo-practice";
import { PageHeader } from "../../../../features/opening/design/ui";

export default async function PhotoPracticePage({ searchParams }: { searchParams: Promise<{ sourceId?: string; conversation?: string }> }) {
  const query = await searchParams;
  const source = uuidSchema.safeParse(query.sourceId);
  const conversation = uuidSchema.safeParse(query.conversation);
  if (!source.success) return <div className="space-y-6"><PageHeader title="拍题练习" /><p>先上传一张题目照片，再开始作答。</p><Link className="text-accent underline" href="/opening/today">返回开始</Link></div>;
  return <PhotoPractice sourceId={source.data} conversationId={conversation.success ? conversation.data : undefined}
    conversationError={query.conversation && !conversation.success ? "原对话链接无效，已停止恢复原对话；仍可继续本次照片练习。" : undefined} />;
}
