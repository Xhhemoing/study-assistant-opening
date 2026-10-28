export type ParserInput = { path: string; mime: string; maxPages: number; timeoutSeconds?: number; pageStart?: number; pageEnd?: number };
export type VisualPageKind = "scan" | "formula" | "table" | "picture";
export type ParsedPage = { page: number; text: string; imagePath: string | null; visualKinds?: VisualPageKind[] };
export type ParserRunner = (argv: string[], signal: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;
export type ParseDocument = (input: ParserInput, signal: AbortSignal) => Promise<ParsedPage[]>;
