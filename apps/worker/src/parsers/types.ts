export type ParserInput = { path: string; mime: string; maxPages: number; timeoutSeconds?: number; pageStart?: number; pageEnd?: number };
export type ParsedPage = { page: number; text: string; imagePath: string | null };
export type ParserStreamOptions = { onLine: (line: string) => Promise<void> };
/** Streaming mode consumes JSONL via onLine and returns an empty stdout. */
export type ParserRunner = (argv: string[], signal: AbortSignal, stream?: ParserStreamOptions) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;
export type ParseDocument = (input: ParserInput, signal: AbortSignal) => Promise<ParsedPage[]>;
