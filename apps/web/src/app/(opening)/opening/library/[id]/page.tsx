import { DocumentEditor } from "../../../../../features/opening/editor/document-editor";
import { ConversationObjectFrame } from "../../../../../features/opening/assistant/conversation-object-frame";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    conversation?: string | string[];
    block?: string | string[];
    activity?: string | string[];
  }>;
};

export default async function OpeningNotePage({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const focusBlockId = typeof query.block === "string" ? query.block : undefined;
  const activityId = typeof query.activity === "string" ? query.activity : undefined;
  // The frame validates an explicit scalar UUID; the editor still owns the
  // original document read/permissions and never supplies its content to chat.
  return <ConversationObjectFrame conversation={query.conversation}>
    <DocumentEditor
      documentId={id}
      basePath="/opening/library"
      {...(focusBlockId !== undefined ? { focusBlockId } : {})}
      {...(activityId !== undefined ? { activityId } : {})}
    />
  </ConversationObjectFrame>;
}
