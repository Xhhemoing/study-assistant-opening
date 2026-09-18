export type ParserInput = { path: string; mime: string; maxPages: number; timeoutSeconds?: number };
export type ParsedPage = { page: number; text: string; imagePath: string | null };
export type ParserRunner = (argv: string[], signal: AbortSignal) => Promise<{ exitCode: number; stdout: string }>;
export type ParseDocument = (input: ParserInput, signal: AbortSignal) => Promise<ParsedPage[]>;
