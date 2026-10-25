import type {PresentationDocument, Source} from './document.mjs';
export function composeText(
  text: string,
  options?: {id?: string; title?: string; sources?: Source[]; final?: boolean}
): {
  document: PresentationDocument;
  pending: {type: string; known: boolean} | null;
  components: number;
};
