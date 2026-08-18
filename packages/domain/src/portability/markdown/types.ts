export type PortableLink = {
  label: string;
  href: string;
};

export type PortableSourceFile = {
  path: string;
  mediaType?: string;
};

export type PortableHeading = { id: string; kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string };
export type PortableParagraph = { id: string; kind: "paragraph"; text: string; links: PortableLink[] };
export type PortableListItem = { id: string; kind: "list-item"; ordered: boolean; text: string };
export type PortableCode = { id: string; kind: "code"; language: string; text: string };
export type PortableMath = { id: string; kind: "math"; text: string };
export type PortableTable = { id: string; kind: "table"; headers: string[]; rows: string[][] };
export type PortableAttachment = {
  id: string;
  kind: "attachment";
  filename: string;
  href: string;
  alt: string;
  mediaType?: string;
};
export type PortableUnsupported = { id: string; kind: "unsupported"; feature: string; detail: string };

export type PortableBlock =
  | PortableHeading
  | PortableParagraph
  | PortableListItem
  | PortableCode
  | PortableMath
  | PortableTable
  | PortableAttachment
  | PortableUnsupported;

export type PortableDocument = {
  id: string;
  title: string;
  tags: string[];
  blocks: PortableBlock[];
  sourceFiles: PortableSourceFile[];
};

export function blockMarker(blockId: string): string {
  return `aistudy-block:${blockId}`;
}
