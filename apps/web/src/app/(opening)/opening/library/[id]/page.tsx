import { DocumentEditor } from "../../../../../features/editor/document-editor";

type Props = { params: Promise<{ id: string }> };

export default async function OpeningNotePage({ params }: Props) {
  const { id } = await params;
  return <DocumentEditor documentId={id} basePath="/opening/library" />;
}
