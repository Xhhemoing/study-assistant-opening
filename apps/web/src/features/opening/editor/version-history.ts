import type { EditorRevision } from "./editor-api";

export type { EditorRevision } from "./editor-api";

export function sortRevisions(revisions: EditorRevision[]): EditorRevision[] {
  return [...revisions].sort((left, right) => right.revisionNumber - left.revisionNumber);
}
