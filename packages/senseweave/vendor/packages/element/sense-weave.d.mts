import type {PresentationDocument, Source} from '../core/document.mjs';
export type Interaction = {
  type: string;
  documentId?: string;
  revision?: number;
  [key: string]: unknown;
};
export type InlineRenderer = (text: string, info: {blockId: string; type: string; role: 'cell' | 'item' | 'title' | 'detail'}) => Node | Node[] | null | undefined;
export class SenseWeave extends HTMLElement {
  /** True when the chrome="none" attribute is set: header, toolbar and sources are hidden. */
  readonly bare: boolean;
  /** Host hook for short inline text (cells, list items); null keeps the built-in plain text. */
  renderInline: InlineRenderer | null;
  sources: Source[];
  document: PresentationDocument | null;
  mode: 'rich' | 'plain';
  motion: boolean;
  log: Interaction[];
  setMode(mode: 'rich' | 'plain'): void;
  setStream(text: string): void;
  /** Progressive render of an inline-composed answer received so far. */
  setComposing(text: string, options?: {id?: string}): void;
  setPreview(document: PresentationDocument, pending?: {type: string; known: boolean} | null): void;
  finishComposing(text: string): void;
  refreshBindings(): void;
  overrides(): Record<string, Record<string, number>>;
  showNotice(text: string): void;
  stopMotion(): void;
  /** [producer revision, local edits] used to order incoming documents. */
  static versionOf(doc: PresentationDocument): [number, number];
}
