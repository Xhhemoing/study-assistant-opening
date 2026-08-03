import { DocumentEditor } from "../../../../features/editor/document-editor";

type Props = { params: Promise<{ id: string }> };

export default async function LibraryDocumentPage({ params }: Props) {
  const { id } = await params;
  return <DocumentEditor documentId={id} />;
}
