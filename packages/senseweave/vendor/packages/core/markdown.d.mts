export type Inline =
  | {type: 'text' | 'code'; text: string}
  | {type: 'strong' | 'em' | 'del'; children: Inline[]}
  | {type: 'link'; href: string; children: Inline[]};
export type MarkdownBlock =
  | {type: 'paragraph'; children: Inline[]}
  | {type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[]}
  | {type: 'code'; language: string; text: string}
  | {type: 'rule'}
  | {type: 'quote'; children: MarkdownBlock[]}
  | {type: 'list'; ordered: boolean; start: number; items: Inline[][]}
  | {type: 'table'; header: Inline[][]; rows: Inline[][][]};
export function parseInline(text: string): Inline[];
export function parseMarkdown(text: string): MarkdownBlock[];
