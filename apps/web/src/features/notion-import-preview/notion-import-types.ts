export type ImportedBlockType =
  | "paragraph"
  | "heading"
  | "bulleted-list"
  | "numbered-list"
  | "to-do"
  | "toggle"
  | "callout"
  | "code"
  | "image"
  | "table"
  | "divider"
  | "columns"
  | "unknown";

export type LossKind =
  | "toggle-flattened"
  | "callout-style"
  | "columns-flattened"
  | "embed-lost"
  | "equation-lost"
  | "color-lost"
  | "attribute-lost";

export interface ImportedLink {
  pageId: string;
  label: string;
}

export interface ImportedBlock {
  type: ImportedBlockType;
  text: string;
  level?: number;
  checked?: boolean;
  items?: string[];
  rows?: string[][];
  src?: string;
  links?: ImportedLink[];
  losses?: LossKind[];
  children?: ImportedBlock[];
  columns?: ImportedBlock[][];
}

export interface ImportedProperty {
  name: string;
  type: string;
  value: string;
}

export interface ImportedPage {
  id: string;
  title: string;
  path: string;
  blocks: ImportedBlock[];
  properties: ImportedProperty[];
  attachments: string[];
  links: ImportedLink[];
  ctime?: string;
  mtime?: string;
}

export interface ZipEntry {
  path: string;
  content: string | Uint8Array;
}

export interface ImportAttachment {
  path: string;
  name: string;
  size: number;
}

export interface ImportReport {
  pages: number;
  blocks: number;
  attachments: number;
  losses: { kind: LossKind; count: number }[];
  pageReports: {
    id: string;
    title: string;
    blockCount: number;
    attachmentCount: number;
    lossKinds: LossKind[];
  }[];
}
