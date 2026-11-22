import { OpeningModelRoutingError } from "@aistudy/ai";
import { openingJobScope } from "@aistudy/database";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { OpeningJobRecord } from "@aistudy/database";
import type { OpeningSourceRepository } from "@aistudy/database";
import { createDoclingProcess, UnsupportedMimeError, ConversionFailedError } from "../parsers/docling-process";
import { markdownChunks } from "./markdown-chunks";
import { htmlChunks } from "./html-chunks";
import type { ParserRunner, ParsedPage, PdfSealMode, VisualPageKind } from "../parsers/types";
import type { OpeningScope } from "@aistudy/database";
import type { NewSourceChunk, OpeningPdfChunkPublisher, OpeningSourceChunksRepository } from "@aistudy/database";
import type { OpeningPdfSegmentsRepository, PdfSegmentPage } from "@aistudy/database";
import { parsePdfSegments, pdfPageEndSeal, watchPdfExecution, type PdfDiscourseBlock } from "../parsers/pdf-segments";
import { pdfParserProfile } from "../parsers/ocr-health";
import { MAX_PDF_RENDER_PAGES } from "../parsers/pdf-page-images";
import { checkPdfPageQuality } from "../parsers/pdf-page-quality";
import { createPdfPartialError } from "./pdf-partial-error";
import { fetchPresignedSourceObject, type LegacyFinalKeyResolver, type SourceDownloadStorage } from "./source-object-download";

export class UnsupportedSourceError extends Error { readonly code = "UNSUPPORTED_SOURCE"; }
const IMAGE_SOURCE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
// The database checks code points. Bounding UTF-16 units also bounds code points.
const PDF_CHUNK_TEXT_LIMIT = 100_000;
const PAGE_SEAL_PROFILE = "pdf-publication-page-seal-v1";
type Storage = SourceDownloadStorage;
type SourceRepo = Pick<OpeningSourceRepository, "get" | "markParseState"> & LegacyFinalKeyResolver;

type AnnotatedParsedPage = ParsedPage & {
  discourseBlocks?: ReadonlyArray<Partial<PdfDiscourseBlock>>;
};

export type SealState = {
  mode: "none" | PdfSealMode;
  inWorkedExample: boolean;
  afterAllSealedPage: boolean;
  unknownAfterFailure?: boolean;
};

function stripHeadingMarkup(line: string): { stripped: string; isMarkdownHeading: boolean } {
  const trimmed = line.trim();
  const isMarkdownHeading = /^#{1,6}\s+\S/u.test(trimmed);
  let s = trimmed;
  if (isMarkdownHeading) {
    s = s.replace(/\s+#+$/u, "");
    if (/^#{1,6}$/u.test(s)) return { stripped: "", isMarkdownHeading };
    s = s.replace(/^(?:#{1,6}\s+)+/u, "").trim();
  }
  while (true) {
    const fullEmphasis = /^(?:\*\*((?:(?!\*\*).)+?)\*\*|__((?:(?!__).)+?)__)$/u.exec(s);
    if (!fullEmphasis) break;
    s = (fullEmphasis[1] ?? fullEmphasis[2] ?? "").trim();
  }
  s = s.replace(/^(?:\*\*((?:(?!\*\*).)+?)\*\*|__((?:(?!__).)+?)__)(?=\s*[:：.—–\s-]|$)/u, "$1$2");
  return { stripped: s, isMarkdownHeading };
}

const SEALED_SECTION_CONTAINER = String.raw`(?:Appendix\b(?:\s+[A-Z0-9]+)?|Chapter\s+\d+|Section\s+\d+(?:\.\d+)*|(?:Lecture|Part|Unit)\s+(?:\d+|[IVXLCDM]+)|第\s*[一二三四五六七八九十百千\d]+\s*(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课])|附录(?:\s*[A-Z0-9一二三四五六七八九十]+)?)`;
const SEALED_CONTAINER_PREFIX = String.raw`(?:${SEALED_SECTION_CONTAINER}(?:\s*[:：.\-—–]\s*|\s+)|附录)`;
const SEALED_HEADING_CONTINUATION = String.raw`(?:\s*\(\s*(?:continued|cont(?:['’]?d)?\.?)\s*\))?`;
const ASSESSMENT_NUMBER = String.raw`#?\d+(?:\.\d+)*`;
const ASSESSMENT_TARGET = String.raw`(?:\s+${ASSESSMENT_NUMBER}(?:(?:\s*[-–—]\s*|\s+(?:to|through)\s+)${ASSESSMENT_NUMBER})?)?`;
const ASSESSMENT_ANSWER_HEADING = String.raw`(?:Answers?|Solutions?|Key)\s+to\s+(?:(?:Selected|Odd-Numbered|Even-Numbered|All|the|Chapter\s+\d+|Section\s+\d+(?:\.\d+)*)\s+)*(?:(?:Exercises?|Problems?|Questions?|Review\s+Questions?|Practice\s+Problems?|Self[- ]Check\s+Exercises?)${ASSESSMENT_TARGET}|Chapter\s+\d+|Section\s+\d+(?:\.\d+)*)`;
const QUALIFIED_ANSWER_SECTION = String.raw`(?:(?:Selected|Odd-Numbered|Even-Numbered)\s+Answers?|Model\s+Answers|(?:Official|Reference)\s+Solutions|Solutions?\s+Manual|Answers?\s+and\s+Solutions?)`;
const CHINESE_ANSWER_HEADING = "(?:参考答案与解析|参考答案|标准答案|正确答案|课后习题答案|课后练习答案|课后练习解答|课后答案|课后解答|章节答案|习题答案|习题解答|练习题答案|练习题解答|练习答案|练习解答|复习题答案|复习题解答|自测题答案|自测题解答|思考题答案|部分习题答案|答案与解析|参考解答|详细解答)";
const CHINESE_ANSWER_CONTINUATION = String.raw`(?:\s*[（(](?:续|接上页)[）)])?`;
const BRACKETED_CHINESE_ANSWER_HEADING = String.raw`【\s*${CHINESE_ANSWER_HEADING}${CHINESE_ANSWER_CONTINUATION}\s*】`;
const CONTAINER_SEALED_HEADING = String.raw`${SEALED_CONTAINER_PREFIX}(?:(?:Answers?\s+Key|(?:(?:Model|Selected|Official|Reference|Correct|Sample|Odd-Numbered|Even-Numbered)\s+)?(?:Answers?|Solutions?))${SEALED_HEADING_CONTINUATION}|(?:${CHINESE_ANSWER_HEADING}|答案|解答)${CHINESE_ANSWER_CONTINUATION})\s*(?:[:：]|$)`;

const SECTION_SEALED_RE = new RegExp(
  String.raw`^(?:(?:${SEALED_SECTION_CONTAINER}\s*[:：.\-—–]?\s*)?(?:(?:Answers?\s+Key|${ASSESSMENT_ANSWER_HEADING}|${QUALIFIED_ANSWER_SECTION}|Answer\s+Section|Answers)${SEALED_HEADING_CONTINUATION}\s*(?:[:：]|$)` +
  "|" + BRACKETED_CHINESE_ANSWER_HEADING +
  String.raw`|${CHINESE_ANSWER_HEADING}${CHINESE_ANSWER_CONTINUATION}\s*(?:[:：]|$)` +
  String.raw`|(?:习题\s*)?(?:答案|解答)(?:\s*(?:（续）|\(续\)|（接上页）|\(接上页\)))?\s*(?:[:：]|$))` +
  "|" + CONTAINER_SEALED_HEADING + ")",
  "iu",
);
const INLINE_WITH_BODY_RE = /[:：]\s*\S/u;
const CHINESE_EXERCISE_ANSWER_RE = new RegExp(
  String.raw`^(?:【\s*正确答案\s*】\s*$|(?:参考答案|标准答案|正确答案|参考解答|详细解答)${CHINESE_ANSWER_CONTINUATION}\s*[:：]\s*\S)`, "u",
);
const QUALIFIED_MULTI_SECTION_RE = new RegExp(
  String.raw`^(?:(?:${SEALED_SECTION_CONTAINER}\s*[:：.\-—–]?\s*)?(?:${ASSESSMENT_ANSWER_HEADING}|${QUALIFIED_ANSWER_SECTION}|${CHINESE_ANSWER_HEADING})` +
  "|" + BRACKETED_CHINESE_ANSWER_HEADING + "|" + CONTAINER_SEALED_HEADING + ")", "iu",
);

const QUALIFIED_ANSWER_LABEL = String.raw`(?:(?:Official|Model|Correct|Sample|Reference)\s+[Aa]nswer|(?:OFFICIAL|MODEL|CORRECT|SAMPLE|REFERENCE)\s+ANSWER)`;
const ENGLISH_SOLUTION_LABEL = String.raw`(?:(?:Worked|Full|Sample|Official|Reference)\s+[Ss]olutions?|(?:WORKED|FULL|SAMPLE|OFFICIAL|REFERENCE)\s+SOLUTIONS?|Solutions?|SOLUTIONS?)`;
const CONTINUED_LABEL = String.raw`(?:\s*\(\s*(?:continued|cont\.?|CONTD?\.?|CONTINUED)\s*\))?`;

const INLINE_SEALED_ALWAYS_RE = new RegExp(
  "^(?:" +
  String.raw`(?:Answer\s+[Kk]ey|ANSWER\s+KEY|Answers?|ANSWERS?)(?:\s+\d+(?:\.\d+)*)?${CONTINUED_LABEL}\s*[:：]` +
  String.raw`|${QUALIFIED_ANSWER_LABEL}(?:\s+\d+(?:\.\d+)*)?${CONTINUED_LABEL}\s*(?:[:：]|$)` +
  String.raw`|【\s*(?:${CHINESE_ANSWER_HEADING}|答案)\s*】` +
  String.raw`|(?:${CHINESE_ANSWER_HEADING}|答案)\s*(?:\d+(?:[.\-]\d+)*)?${CHINESE_ANSWER_CONTINUATION}\s*[:：]` +
  ")",
  "u",
);

const INLINE_SEALED_NON_EXAMPLE_RE = new RegExp(
  "^(?:" +
  String.raw`${ENGLISH_SOLUTION_LABEL}(?:\s+(?:to|TO)\s+(?:Exercise|EXERCISE|Problem|PROBLEM|Question|QUESTION)\s*\d*(?:\.\d+)*)?(?:\s+\d+(?:\.\d+)*)?${CONTINUED_LABEL}\s*[:：]` +
  "|【\\s*(?:参考解答|详细解答|解答|详解|解析)\\s*】" +
  "|(?:参考解答|详细解答|解答|详解|解析|解)\\s*(?:\\d+(?:[.\\-]\\d+)*)?\\s*(?:（续）|\\(续\\)|（接上页）|\\(接上页\\))?\\s*[:：]" +
  ")",
  "u",
);

const STANDALONE_SOLUTION_HEADING_RE = new RegExp(String.raw`^(?!(?:Solutions|SOLUTIONS)\b)(?:${ENGLISH_SOLUTION_LABEL}|解答|详细解答|参考解答|解析|详解)${CONTINUED_LABEL}\s*$`, "u");
const WORKED_EXAMPLE_RE = new RegExp(String.raw`^(?:${SEALED_SECTION_CONTAINER}(?:\s*[:：.\-—–]\s*|\s+))?(?:(?:Worked\s+Example|WORKED\s+EXAMPLE|Example|EXAMPLE)(?:\s+\d+(?:[.-]\d+)*(?:\s*\([^)]+\))?(?:\s*[:：.—-]|\s+|$)|(?:\s*\([^)]+\))?\s*(?:[:：.—-]|$))|例题(?:\s*\d+(?:[.-]\d+)*(?:\s*[（(][^）)]+[）)])?(?:\s*[:：.．—-]|\s+|$)|\s*(?:[:：.．—-]|$))|例(?:\s*\d+(?:[.-]\d+)*(?:\s*[（(][^）)]+[）)])?(?:\s*[:：.．—-]|\s+|$)|\s*[:：]))`, "iu");
const WORKED_EXAMPLE_INTERNAL_RE = new RegExp(
  String.raw`^(?:(?!(?:(?:Official|Reference)\s+[Ss]olutions|(?:OFFICIAL|REFERENCE)\s+SOLUTIONS|Solutions|SOLUTIONS)\b)(?:${ENGLISH_SOLUTION_LABEL}|Proof|PROOF)${CONTINUED_LABEL}\s*(?:[:：]|\.(?:\s|$)|$)` +
  String.raw`|(?:详细解答|参考解答|解答|详解|解析|证明|证|解|分析)(?:\s*(?:（续）|\(续\)|（接上页）|\(接上页\)))?\s*(?:[:：]|$)|【\s*(?:解答|证明|证|解|分析|详解|解析)\s*】)`, "u",
);
const EXERCISE_OPENER_RE = /^(?:(?:Exercises?|EXERCISES?|Practice\s+Problems?|PRACTICE\s+PROBLEMS?|Problem\s+\d+|PROBLEM\s+\d+|Question\s+\d+|QUESTION\s+\d+)\b|(?:习题|练习题|练习|思考题|作业题))/u;
const PUBLIC_BLOCK_OPENER_RE = /^(?:(?:Definition|DEFINITION|Notation|NOTATION|Terminology|TERMINOLOGY|Convention|CONVENTION|Theorem|THEOREM|Lemma|LEMMA|Proposition|PROPOSITION|Corollary|COROLLARY|Axiom|AXIOM|Conjecture|CONJECTURE|Claim|CLAIM|Proof|PROOF|Chapter\s+\d+|CHAPTER\s+\d+|Section\s+\d+|SECTION\s+\d+|Part\s+\d+|PART\s+\d+|Figure\s+\d+|Fig\.?\s+\d+|Table\s+\d+)\b|(?:定义|记号|术语|约定|定理|引理|推论|命题|公理|猜想|证明|图\s*\d+|表\s*\d+|第\s*[一二三四五六七八九十百千\d]+\s*(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课]))|\d+(?:\.\d+)+\s+\S)/u;
const NON_ANSWER_AFTER_BLANK_RE = /^(?:(?:Exercises?|EXERCISES?|Practice\s+Problems?|PRACTICE\s+PROBLEMS?|Problems?|PROBLEMS?|Questions?|QUESTIONS?|Proof|PROOF|Figures?|FIGURES?|Fig\.?|Tables?|TABLES?)\b|(?:习题|练习题|练习|问题|思考题|作业题|证明|图\s*\d+|表\s*\d+|第\s*\d+\s*题|题\s*\d+))/u;
const MAJOR_NON_ANSWER_HEADING_RE = /^(?:(?:Bibliography|References|Works\s+Cited|Index|Subject\s+Index|Author\s+Index|Glossary|Notation\s+Index|Acknowledg(?:e)?ments?|About\s+the\s+Authors?|Afterword|Colophon|参考文献|索引|名词索引|主题索引|符号表|词汇表|后记|致谢)(?:\s*[:：.—–-]|$)|(?:Appendix(?:\s+[A-Z0-9]+)?|附录(?:\s*[A-Z0-9一二三四五六七八九十]+)?)(?:\s*[:：.—–-]\s*(?!.*(?:\b(?:Answers?|Solutions?|Keys?)\b|答案|解答)).*)?$)/iu;
const SECTION_SEALED_SUBHEADER_RE = /^(?:(?:Chapter|CHAPTER|Part|PART|Unit|UNIT|Section|SECTION|Lecture|LECTURE)\s+(?:\d+(?:\.\d+)*|[IVXLCDM]+)\s*[:：.—-]?$|(?:Exercises?|EXERCISES?|Problems?|PROBLEMS?|Questions?|QUESTIONS?|Review|REVIEW|Practice|PRACTICE|Quiz|QUIZ|Drills?|DRILLS?|Self-Check|SELF-CHECK)\b|第\s*[一二三四五六七八九十百千\d]+\s*(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课])\s*$|(?:习题|练习题?|思考题|复习题|作业题|自测题|第\s*[一二三四五六七八九十百千\d]+\s*[题小题])|(?:\d+[.)]|[A-Za-z][.)])(?:\s|$)|(?:\d+(?:\.\d+)*|[A-Za-z])$|[（(]\s*(?:\d+|[a-zA-Z]|[一二三四五六七八九十]+)\s*[)）])/u;
const TEXTBOOK_STRUCTURAL_OPENER_RE = /^(?:(?:Definition|DEFINITION|Notation|NOTATION|Terminology|TERMINOLOGY|Convention|CONVENTION|Axiom|AXIOM|Theorem|THEOREM|Lemma|LEMMA|Proposition|PROPOSITION|Corollary|COROLLARY|Conjecture|CONJECTURE|Claim|CLAIM)\b|(?:Worked\s+Example|WORKED\s+EXAMPLE|Example|EXAMPLE)(?:\s+\d+(?:[.-]\d+)*)?(?:\s*\([^)]+\))?(?:\s*[:：.—-]|\s+\S|$)|(?:定义|记号|术语|约定|公理|定理|引理|推论|命题|猜想|例题)(?:\b|\s*\d|\s*[:：]|$)|例\s*\d+)/u;
const NUMBERED_CONTAINER_PREFIX_RE = /^(?:(?:(?:Chapter|Part|Unit|Lecture|Lesson|Module)\s+(?:\d+(?:\.\d+)*|[IVXLCDM]+)|Section\s+\d+(?:\.\d+)*)(?=[\s:：.．—–-]|$)|第\s*[一二三四五六七八九十百千\d]+\s*(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课]))/iu;
const UNHEADED_ANSWER_CONTINUATION_RE = /^(?:(?:\d+[.)]|\d+(?:\.\d+)+[.)]?|\(\d+\)|\(\s*[a-zA-Z]\s*\)|[a-zA-Z][.)]|第\s*[一二三四五六七八九十百千\d]+\s*[题小题]|[（(]\s*[一二三四五六七八九十]+\s*[)）])(?:\s+|$)|(?:Chapter|CHAPTER|Section|SECTION|Part|PART|Unit|UNIT|Lecture|LECTURE)\s+(?:\d+(?:\.\d+)*|[IVXLCDM]+)\s*[:：.—-]?$|第\s*[一二三四五六七八九十百千\d]+\s*(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课])\s*$)/u;
const TITLE_CASE_SECTION_HEADING_RE = /^\d+(?:\.\d+)+\s+(?!True$|False$|Yes$|No$|None$|[A-F](?:\s*,\s*[A-F])*$)[A-Z][A-Za-z0-9]*(?:\s+[A-Za-z0-9,&-]+){0,8}$/u;
const ANSWER_OR_REVIEW_TITLE_RE = /\b(?:Answers?|Solutions?|Exercises?|Problems?|Questions?|Review|Practice|Quiz|Drills?|Self-Check|Homework|Assignments?|Problem\s*Sets?|Worksheets?|Tutorials?|Recitations?|Labs?)\b|答案|解答|习题|练习|思考题|复习题|自测题|作业|课后题|单元测试/iu;
const CONTAINER_OR_NUMBERED_HEADING_RE = /^(?:(?:Chapters?|Sections?|Parts?|Units?|Lectures?|Lessons?|Modules?|Appendix)\b|第\s*[一二三四五六七八九十百千\d]+\s*(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课])|附录|\d+(?:\.\d+)+\s+)/iu;
const PAGE_METADATA_HEADING_RE = /^(?:[[【(]\s*)?(?:(?:(?:scanned|physical|printed|pdf)\s+)*(?:pages?|slides?)\b|(?:p|pp)\.\s*\d|(?:(?:cached|raw|readable|verified|automatic)\s+)*(?:transcription|ocr)\b|(?:第\s*)?[\d一二三四五六七八九十百千]+(?:\s*(?:[/／\-–—]|共)\s*(?:第\s*)?[\d一二三四五六七八九十百千]+)?\s*[页頁张張]|\d+\s*(?:of|[/／\-–—])\s*\d+\s*[.)。]?$|原图忠实转写|视觉转写与描述|原生提取|本地提取|图表观察描述|识别不确定)/iu;
const SECTION_SEALED_TERMINATOR_RE = /(?:End\s+of\s+(?:Answers?|Solutions?)|答案完|解答完)\s*[.。]?\s*$/iu;
const INLINE_SEALED_TERMINATOR_RE = /(?:[□■∎]|End\s+of\s+Answers?|答案完|解答完)\s*[.。]?\s*$/iu;
const BARE_ANSWER_LABEL_RE = /^(?:答案|解答)\s*[:：]$/u;
const SAVED_VISION_MARKER_RE = /(?:^|\r?\n)\[视觉转写与描述\](?:\r?\n|$)/u;
const SAVED_NATIVE_HEADER_RE = /^\[(?:原生提取|本地提取（可能含OCR）)\]\r?\n/u;
const TERMINAL_PUNCTUATION_RE = /[.。!?！？;；)）\]】□■∎]$/u;
const NEXT_CONTINUATION_RE = /(?:\(\s*(?:to\s+be\s+continued|continued(?:\s+on\s+next\s+page)?)\s*\)|[（(]\s*(?:下接下页|转下页|未完待续)\s*[）)]|接下页|转下页)$/iu;
const CONTINUATION_HEADING_RE = /(?:\b(?:continued|cont(?:['’]?d)?)(?:\s+(?:from|on)\s+.+)?[.\s:：]*$|[([（【]\s*(?:(?:to\s+be\s+)?continued|cont(?:['’]?d)?\.?|续|续上页|接上页)\s*[)\]）】]|(?:接上页|续上页|\s续)\s*[:：.]?$)/iu;

const RUNNING_COUNTER_RE = /(?:^[(（[]?\s*(?:\d+(?:\.\d+)*|[ivxlcdm]{1,8})\s*[)）\].．、]?$|[(（[]\s*(?:(?:pages?|slides?)\s+\d+|pp?\.\s*\d+|第\s*\d+\s*[页頁])(?:\s*(?:of|[/／–-])\s*\d+)?\s*[)）\]]|(?:\s|[:：—–-]\s*)(?:(?:pages?|slides?)\s+\d+|pp?\.\s*\d+|第\s*\d+\s*[页頁])(?:\s*(?:of|[/／–-])\s*\d+)?\s*[.。]?$)/iu;
const OCR_PLACEHOLDER_RE = /^[[【(（]\s*(?:illegible|unreadable|blank|unclear|ocr|no\s+(?:readable\s+)?text|无法识别|无法辨认|空白页|图片描述|图像描述|图示与版面描述|不确定处)(?=[\s\]】)）：:]|$)/iu;

function isRunningPageHeading(stripped: string): boolean {
  if (PAGE_METADATA_HEADING_RE.test(stripped) || CONTINUATION_HEADING_RE.test(stripped)
    || RUNNING_COUNTER_RE.test(stripped) || OCR_PLACEHOLDER_RE.test(stripped)) return true;
  const container = NUMBERED_CONTAINER_PREFIX_RE.exec(stripped)?.[0];
  return Boolean(container && /^[\s:：.．—–-]*$/u.test(stripped.slice(container.length)));
}

function needsVerifiedImage(kinds: readonly VisualPageKind[]): boolean {
  return kinds.includes("scan") || kinds.includes("picture");
}

function hasVerifiedPageText(text: string): boolean {
  const content = text.split(/\r?\n/u).map(line => stripHeadingMarkup(line).stripped)
    .filter(line => !isRunningPageHeading(line)).join("\n");
  return checkPdfPageQuality(content).quality === "ok";
}

function isSectionSealedHeader(stripped: string): boolean {
  const heading = stripped.replace(/\*\*|__/gu, "");
  if (!SECTION_SEALED_RE.test(heading)) return false;
  if (INLINE_WITH_BODY_RE.test(heading)) return QUALIFIED_MULTI_SECTION_RE.test(heading);
  return true;
}

function isSectionSealedExit(stripped: string, isMarkdownHeading: boolean): boolean {
  if (!stripped || isSectionSealedHeader(stripped) || isRunningPageHeading(stripped)
    || /^(?:\d+(?:\.\d+)*[.)]?\s+)?(?:true|false|yes|no|none|[a-f](?:\s*,\s*[a-f])*)[.。]?$/iu.test(stripped)) return false;
  if (MAJOR_NON_ANSWER_HEADING_RE.test(stripped) && !ANSWER_OR_REVIEW_TITLE_RE.test(stripped)) return true;
  if (TEXTBOOK_STRUCTURAL_OPENER_RE.test(stripped)) return true;
  if (isTitledPublicContainer(stripped)) return true;
  if (!isMarkdownHeading) return false;
  if (INLINE_SEALED_ALWAYS_RE.test(stripped) || INLINE_SEALED_NON_EXAMPLE_RE.test(stripped)) return false;
  if (STANDALONE_SOLUTION_HEADING_RE.test(stripped) || SECTION_SEALED_SUBHEADER_RE.test(stripped)) return false;
  if (ANSWER_OR_REVIEW_TITLE_RE.test(stripped)) return false;
  return TITLE_CASE_SECTION_HEADING_RE.test(stripped) || !CONTAINER_OR_NUMBERED_HEADING_RE.test(stripped);
}

function isTitledPublicContainer(stripped: string): boolean {
  const prefix = NUMBERED_CONTAINER_PREFIX_RE.exec(stripped)?.[0];
  if (!prefix) return false;
  const title = stripped.slice(prefix.length).replace(/^[\s:：.．—–-]+/u, "");
  if (!/\p{L}/u.test(title) || ANSWER_OR_REVIEW_TITLE_RE.test(title)) return false;
  if (/^(?:\*\*|__)?(?:Key\b|\(?cont|\(?续)/iu.test(title)) return false;
  return !/^Section\b/iu.test(prefix) || /^(?:\*\*|__)?(?!(?:is|are|was|see)\b)[A-Za-z\u4e00-\u9fff]/iu.test(title);
}

function splitPdfChunk(text: string) {
  const marker = SAVED_VISION_MARKER_RE.exec(text);
  const native = marker ? text.slice(0, marker.index) : text;
  const vision = marker ? text.slice(marker.index + marker[0].length) : "";
  const nativeHeader = SAVED_NATIVE_HEADER_RE.exec(native)?.[0] ?? "";
  return { nativeBody: native.slice(nativeHeader.length).trimEnd(), nativeHeader, vision, marker };
}

function isRecoverySectionHeading(stripped: string): boolean {
  if (isSectionSealedHeader(stripped) || isRunningPageHeading(stripped) || ANSWER_OR_REVIEW_TITLE_RE.test(stripped)) return false;
  return isTitledPublicContainer(stripped) || TITLE_CASE_SECTION_HEADING_RE.test(stripped)
    || MAJOR_NON_ANSWER_HEADING_RE.test(stripped)
    || /^(?:(?:Appendix|Preface|Introduction)\b|附录|序言|前言|引言)/iu.test(stripped);
}

function beginsWithRecoverySection(text: string): boolean {
  const { stripped } = stripHeadingMarkup(text.trimStart().split(/\r?\n/u, 1)[0] ?? "");
  return isRecoverySectionHeading(stripped);
}

function isRecoveryProseLine(line: string): boolean {
  const { stripped, isMarkdownHeading } = stripHeadingMarkup(line);
  return !isMarkdownHeading && !isRunningPageHeading(stripped) && !isRecoverySectionHeading(stripped)
    && !EXERCISE_OPENER_RE.test(stripped) && !EXERCISE_INSTRUCTION_RE.test(stripped)
    && /^\p{L}/u.test(stripped) && !/^[\p{L}\p{N}]+\s*[=≈≤≥]/u.test(stripped);
}

function hasRecoverySeal(text: string): boolean {
  return stripSealedSolutionLines(text, { mode: "none", inWorkedExample: false, afterAllSealedPage: false }) !== text;
}

function isStandaloneRecoveryProse(text: string): boolean {
  const lines = text.trim().split(/\r?\n/u);
  return isRecoveryProseLine(lines[0]!) && hasVerifiedPageText(text) && !hasRecoverySeal(text)
    && !lines.some(line => {
      const { stripped } = stripHeadingMarkup(line);
      return EXERCISE_OPENER_RE.test(stripped) || EXERCISE_INSTRUCTION_RE.test(stripped);
    });
}

function isStandaloneRecoverySection(text: string): boolean {
  if (!beginsWithRecoverySection(text) || !hasVerifiedPageText(text) || hasRecoverySeal(text)) return false;
  const [, ...body] = text.trim().split(/\r?\n/u);
  // An unlabelled answer or formula alone does not corroborate a recovered heading.
  return !body.length || body.some(isRecoveryProseLine);
}

const EXERCISE_INSTRUCTION_RE = /^(?:\d+[.)]\s+)?(?:Find|Solve|Compute|Calculate|Determine|Show|Prove|Evaluate|Explain|Sketch|Draw|Derive|Simplify)\b/u;

function stripSealedSolutionLines(
  text: string,
  state: SealState,
  onModeTransition?: (prevMode: SealState["mode"], nextMode: SealState["mode"], explicitOpener: boolean) => void,
  requirePublicVisionHeading: boolean | "heading-only" = false,
): string {
  const lines = text.trimEnd().split(/\r?\n/u);
  const kept: string[] = [];
  let changed = false;
  let publish = !requirePublicVisionHeading;
  let firstContentLine = true;
  let inExercise = false;
  let lastInlineBodyLine = "";
  const hasSectionSeal = requirePublicVisionHeading
    && lines.some(line => {
      const { stripped } = stripHeadingMarkup(line);
      return !BARE_ANSWER_LABEL_RE.test(stripped) && isSectionSealedHeader(stripped);
    });

  const keep = (line: string) => {
    if (publish) kept.push(line);
    else changed = true;
  };

  const setMode = (nextMode: SealState["mode"], explicitOpener = false) => {
    if (requirePublicVisionHeading && nextMode !== "none") publish = false;
    const prevMode = state.mode;
    state.mode = nextMode;
    if (nextMode === "section_sealed") inExercise = false;
    if (prevMode !== nextMode || explicitOpener) onModeTransition?.(prevMode, nextMode, explicitOpener);
    if (nextMode !== "inline_sealed") lastInlineBodyLine = "";
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (state.mode === "inline_sealed") {
        if (lastInlineBodyLine) setMode("none");
        changed = true;
      } else if (state.mode === "section_sealed" || state.unknownAfterFailure) {
        changed = true;
      } else {
        keep(line);
      }
      continue;
    }

    const { stripped, isMarkdownHeading } = stripHeadingMarkup(line);
    const exerciseAnswer = inExercise && (BARE_ANSWER_LABEL_RE.test(stripped) || CHINESE_EXERCISE_ANSWER_RE.test(stripped));
    const sectionHeader = !exerciseAnswer && isSectionSealedHeader(stripped);
    if (!sectionHeader && (state.mode !== "none" || state.unknownAfterFailure || state.afterAllSealedPage)
      && isRunningPageHeading(stripped) && !(inExercise && !isMarkdownHeading && /^\d+[.。]$/u.test(stripped))) {
      changed = true;
      continue;
    }
    if (state.unknownAfterFailure) {
      if (!sectionHeader && !isRecoverySectionHeading(stripped)) {
        changed = true;
        continue;
      }
      state.unknownAfterFailure = false;
    }
    const titledPublicContainer = isTitledPublicContainer(stripped);
    if (requirePublicVisionHeading === "heading-only") publish = false;
    if (requirePublicVisionHeading && !sectionHeader && (
      titledPublicContainer || TEXTBOOK_STRUCTURAL_OPENER_RE.test(stripped)
      || MAJOR_NON_ANSWER_HEADING_RE.test(stripped) || EXERCISE_OPENER_RE.test(stripped)
      || EXERCISE_INSTRUCTION_RE.test(stripped)
      || (firstContentLine && hasSectionSeal && isMarkdownHeading && isSectionSealedExit(stripped, true))
    )) publish = true;
    firstContentLine = false;

    if (state.mode === "section_sealed") {
      if (isSectionSealedExit(stripped, isMarkdownHeading)) {
        setMode("none");
        state.inWorkedExample = WORKED_EXAMPLE_RE.test(stripped);
        keep(line);
      } else {
        changed = true;
        if (SECTION_SEALED_TERMINATOR_RE.test(trimmed)) setMode("none");
      }
      continue;
    }

    if (state.afterAllSealedPage) {
      state.afterAllSealedPage = false;
      if (
        !isMarkdownHeading
        && !isSectionSealedExit(stripped, isMarkdownHeading)
        && !NON_ANSWER_AFTER_BLANK_RE.test(stripped)
        && !WORKED_EXAMPLE_RE.test(stripped)
        && !TITLE_CASE_SECTION_HEADING_RE.test(stripped)
        && UNHEADED_ANSWER_CONTINUATION_RE.test(stripped)
      ) {
        setMode("section_sealed");
        state.inWorkedExample = false;
        changed = true;
        if (SECTION_SEALED_TERMINATOR_RE.test(trimmed)) setMode("none");
        continue;
      }
    }

    if (state.inWorkedExample && WORKED_EXAMPLE_INTERNAL_RE.test(stripped)) {
      setMode("none");
      keep(line);
      continue;
    }

    if (sectionHeader) {
      setMode("section_sealed", true);
      state.inWorkedExample = false;
      changed = true;
      if (SECTION_SEALED_TERMINATOR_RE.test(trimmed)) setMode("none");
      continue;
    }

    const inlineOpener = INLINE_SEALED_ALWAYS_RE.exec(stripped) ?? (!state.inWorkedExample
      ? INLINE_SEALED_NON_EXAMPLE_RE.exec(stripped) ?? STANDALONE_SOLUTION_HEADING_RE.exec(stripped)
      : null);
    if (inlineOpener) {
      setMode("inline_sealed", true);
      state.inWorkedExample = false;
      lastInlineBodyLine = stripped.slice(inlineOpener[0].length).replace(/^\s*[:：]?\s*/u, "");
      changed = true;
      if (INLINE_SEALED_TERMINATOR_RE.test(lastInlineBodyLine)) setMode("none");
      continue;
    }

    if (WORKED_EXAMPLE_RE.test(stripped)) {
      setMode("none");
      state.inWorkedExample = true;
      inExercise = false;
      keep(line);
      continue;
    }

    const exerciseOpener = EXERCISE_OPENER_RE.test(stripped);
    if (
      exerciseOpener || PUBLIC_BLOCK_OPENER_RE.test(stripped)
      || MAJOR_NON_ANSWER_HEADING_RE.test(stripped)
      || titledPublicContainer
      || (isMarkdownHeading && !STANDALONE_SOLUTION_HEADING_RE.test(stripped))
    ) {
      setMode("none");
      state.inWorkedExample = false;
      inExercise = exerciseOpener;
      keep(line);
      continue;
    }

    if (state.mode === "inline_sealed") {
      changed = true;
      lastInlineBodyLine = trimmed;
      if (INLINE_SEALED_TERMINATOR_RE.test(trimmed)) setMode("none");
      continue;
    }

    keep(line);
  }

  if (state.mode === "inline_sealed" && TERMINAL_PUNCTUATION_RE.test(lastInlineBodyLine)
    && !NEXT_CONTINUATION_RE.test(lastInlineBodyLine)) setMode("none");

  if (!changed) return text;
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
  return kept.join("\n");
}

export function sealTextWithState(
  rawText: string,
  state: SealState,
  pageNumber?: number,
  discourseBlocks?: AnnotatedParsedPage["discourseBlocks"],
  onModeTransition?: (previous: SealState["mode"], next: SealState["mode"]) => void,
): string {
  let text = rawText;
  if (Array.isArray(discourseBlocks) && discourseBlocks.length > 0 && text.length > 0) {
    const codePoints = Array.from(text);
    const spans: Array<[number, number]> = [];
    for (const block of discourseBlocks) {
      if (typeof block.pageNumber === "number" && pageNumber !== undefined && block.pageNumber !== pageNumber) continue;
      if (block.kind !== "solution_sealed" && block.visibilityHint !== "sealed") continue;
      const candidates: Array<[unknown, unknown]> = [
        [block.rawCharStart, block.rawCharEnd],
        [block.charStart, block.charEnd],
      ];
      for (const [start, end] of candidates) {
        if (typeof start === "number" && typeof end === "number" && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= codePoints.length) {
          if (typeof block.text === "string" && codePoints.slice(start, end).join("") !== block.text) continue;
          spans.push([start, end]);
          break;
        }
      }
    }
    if (spans.length > 0) {
      spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let cursor = 0;
      const parts: string[] = [];
      for (const [start, end] of spans) {
        if (start > cursor) parts.push(codePoints.slice(cursor, start).join(""));
        cursor = Math.max(cursor, end);
      }
      if (cursor < codePoints.length) parts.push(codePoints.slice(cursor).join(""));
      text = parts.join("").replace(/\n{3,}/g, "\n\n").trim();
    }
  }
  return stripSealedSolutionLines(text, state, onModeTransition);
}

function readCappedPdfPages(value: unknown): Set<number> {
  if (Array.isArray(value)) {
    return new Set(value.filter((page): page is number => Number.isInteger(page) && page >= 1 && page <= 2_000));
  }
  // Older partial warnings store only the ranges shown in the reader.
  const ranges = typeof value === "string"
    ? value.match(/(?:^|；)第 (\d{1,4}(?:–\d{1,4})?(?:、\d{1,4}(?:–\d{1,4})?)*)(?: 等共 \d{1,4})? 页达到文本长度上限，已保留原文或截短$/u)?.[1]
    : undefined;
  const pages = new Set<number>();
  for (const range of ranges?.split("、") ?? []) {
    const [start, end = start] = range.split("–").map(Number) as [number, number?];
    for (let page = Math.max(1, start); page <= Math.min(2_000, end); page++) pages.add(page);
  }
  return pages;
}

function trackSourceDownload(source: { bytes: number; sha256?: string | null }) {
  const digest = createHash("sha256");
  let bytes = 0;
  return {
    add(chunk: Uint8Array) {
      bytes += chunk.byteLength;
      if (bytes > source.bytes) throw new Error("source download exceeds declared bytes");
      digest.update(chunk);
    },
    finish() {
      if (bytes !== source.bytes) {
        throw new Error(`source download integrity check failed: expected ${source.bytes} bytes, received ${bytes}`);
      }
      const sha256 = digest.digest("hex");
      if (source.sha256 && sha256 !== source.sha256.toLowerCase()) {
        throw new Error("source download integrity check failed: SHA-256 mismatch");
      }
    },
  };
}

async function* readStagedPdfChunks(file: string, signal: AbortSignal): AsyncGenerator<NewSourceChunk> {
  let pending = "";
  for await (const data of createReadStream(file, { encoding: "utf8", signal })) {
    pending += data;
    let start = 0;
    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n", start)) {
      yield JSON.parse(pending.slice(start, end)) as NewSourceChunk;
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  if (pending) throw new Error("incomplete PDF chunk staging file");
}

export type ParseSourceVisualPageInput = {
  scope: OpeningScope; job: OpeningJobRecord; sourceId: string; sourceVersion: number;
  physicalPage: number; nativeText: string; visualKinds: VisualPageKind[];
  /** Worker-owned original file, not a parser/model-provided image path. */
  localFilePath: string; mime: string; signal: AbortSignal;
};
export type ParseSourceVisualPageResult = { text: string; imageObjectKey: string };
type RecognizeSourcePage = (input: ParseSourceVisualPageInput) => Promise<ParseSourceVisualPageResult>;

export function createParseSourceHandler(deps: { sources: SourceRepo; chunks: Pick<OpeningSourceChunksRepository, "replaceChunks" | "listChunksAtVersion"> & OpeningPdfChunkPublisher; storage: Storage; runner: ParserRunner; tempDir: string;
  segments?: Pick<OpeningPdfSegmentsRepository, "read" | "save"> & Partial<Pick<OpeningPdfSegmentsRepository, "assertCurrent" | "readPageSeals">>;
  segmentPages?: number; segmentTimeoutSeconds?: number; executionPollMs?: number;
  recognizePage?: RecognizeSourcePage;
  /** Yields one result per input in physical page order. Null means a cache miss with model routing unavailable. */
  recognizePages?: (inputs: readonly ParseSourceVisualPageInput[], cacheOnly: boolean) => AsyncGenerator<ParseSourceVisualPageResult | null, void, void>;
  assertCurrent?: (scope: OpeningScope, input: { sourceId: string; sourceVersion: number }) => Promise<void>;
  onSourceReady?: (scope: OpeningScope, input: { sourceId: string; sourceVersion: number }) => Promise<void> }) {
  const parser = createDoclingProcess({ run: deps.runner });
  // The parser child runs with cwd=services/parser; a relative tempDir would
  // resolve there and the CLI would reject the input as missing (exit 4).
  const tempDir = path.resolve(deps.tempDir);
  return async (job: OpeningJobRecord, payload: unknown) => {
    const sourceId = (payload as { sourceId?: unknown }).sourceId;
    if (typeof sourceId !== "string") throw new Error("parse payload missing sourceId");
    const scope = openingJobScope(job);
    const source = await deps.sources.get(scope, sourceId, { includePdfTextCap: true });
    if (source.uploadState !== "uploaded") throw new Error("source is not uploaded");
    const expectedVersion = (payload as { sourceVersion?: unknown }).sourceVersion;
    if (expectedVersion !== undefined && expectedVersion !== source.version) throw Object.assign(new Error("source version changed during parse"), { code: "CONFLICT" });
    // Claimed production PDF jobs must have durable recovery and cancellation
    // wiring; legacy direct/test callers without a claim can remain ephemeral.
    if (source.mime === "application/pdf" && job.claimToken && !deps.segments) throw new Error("PDF segment repository is required for claimed parse jobs");
    if (source.mime === "text/markdown" || source.mime === "text/plain" || source.mime === "text/html") {
      const response = await fetchPresignedSourceObject({
        scope,
        source,
        job,
        payload,
        storage: deps.storage,
        sources: deps.sources,
      });
      if (!response.ok) throw new Error("source download failed");
      const parts: Uint8Array[] = [];
      const download = trackSourceDownload(source);
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            download.add(value);
            parts.push(value);
          }
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          throw error;
        } finally { reader.releaseLock(); }
      }
      download.finish();
      const text = new TextDecoder().decode(Buffer.concat(parts));
      const chunks = source.mime === "text/html" ? htmlChunks(text) : markdownChunks(text); // plain text uses markdown chunker
      await deps.chunks.replaceChunks(scope, { sourceId: source.id, sourceVersion: source.version, chunks: chunks.map((chunk) => ({ page: chunk.page, slideLabel: null, startMs: null, endMs: null, text: chunk.text, imageObjectKey: null })) });
      if (deps.onSourceReady) {
        try { await deps.onSourceReady(scope, { sourceId: source.id, sourceVersion: source.version }); } catch { /* best-effort */ }
      }
      return { pages: chunks.length };
    }
    const isImage = IMAGE_SOURCE_MIMES.has(source.mime);
    if (isImage && job.claimToken && !deps.assertCurrent) throw new Error("source execution check is required for claimed image parse jobs");
    // Legacy .ppt and .eml: keep the object stored, but do not claim readable text for tutoring.
    if (source.mime === "application/vnd.ms-powerpoint" || source.mime === "message/rfc822") {
      await deps.sources.markParseState(scope, source.id, "unsupported");
      return { unsupported: true, storedOnly: true };
    }
    if (!isImage && source.mime !== "application/pdf" && source.mime !== "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
      await deps.sources.markParseState(scope, source.id, "unsupported");
      return { unsupported: true };
    }
    await mkdir(tempDir, { recursive: true });
    const workDir = await mkdtemp(path.join(tempDir, `${source.id}-${source.version}-`));
    const temp = path.join(workDir, "source");
    let execution: Awaited<ReturnType<typeof watchPdfExecution>> | undefined;
    try {
      const assertCurrent = (isImage || source.mime === "application/pdf") && deps.assertCurrent
        ? () => deps.assertCurrent!(scope, { sourceId: source.id, sourceVersion: source.version })
        : source.mime === "application/pdf" && deps.segments?.assertCurrent
          ? () => deps.segments!.assertCurrent!(scope, { sourceId: source.id, sourceVersion: source.version }) : undefined;
      if (assertCurrent) execution = await watchPdfExecution(assertCurrent, deps.executionPollMs);
      const signal = execution?.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      const response = await fetchPresignedSourceObject({
        scope,
        source,
        job,
        payload,
        storage: deps.storage,
        sources: deps.sources,
        signal,
      });
      if (!response.ok || !response.body) throw new Error("source download failed");
      const download = trackSourceDownload(source);
      const limited = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try { download.add(chunk); }
          catch (error) { callback(error as Error); return; }
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), limited, createWriteStream(temp), { signal });
      download.finish();
      signal.throwIfAborted();
      const isPdf = source.mime === "application/pdf";
      let visualRecognitionUnavailable = !deps.recognizePage && !(isPdf && deps.recognizePages);
      const skippedVisionPages: number[] = [];
      const cappedTextPages = new Set<number>();
      let hasSealedContent = false;
      const VISION_TRANSCRIPTION_HEADER = "【原图忠实转写，尚需核对】";
      const VISION_DESCRIPTION_HEADER = "【图表观察描述，非原文或解答】";
      const VISION_UNCERTAINTIES_HEADER = "【识别不确定，不能据此判定正确】";
      const sealVisionBodyWithTransitions = (rawBody: string, sealState: SealState, requirePublicHeading: boolean) => {
        let sawSectionExit = false;
        let reenteredSectionSealed = false;
        let openedInlineAtEnd = false;
        let detectedOnPage = false;
        let explicitBoundary = false;
        const enteredUnknown = sealState.unknownAfterFailure;
        const incomingMode = sealState.mode;
        const enteredSealed = incomingMode === "section_sealed" || sealState.afterAllSealedPage;
        const sealed = stripSealedSolutionLines(
          rawBody,
          sealState,
          (prevMode, nextMode, explicitOpener) => {
            explicitBoundary ||= explicitOpener;
            if (prevMode === "section_sealed" && nextMode === "none") sawSectionExit = true;
            if (nextMode === "section_sealed" && sawSectionExit) reenteredSectionSealed = true;
            // The scanner also notifies when an explicit inline opener replaces an existing one.
            openedInlineAtEnd = nextMode === "inline_sealed";
            detectedOnPage ||= nextMode !== "none";
          },
          requirePublicHeading,
        );
        const confirmedSeal = incomingMode !== "none" || sealState.mode !== "none" || detectedOnPage;
        const visionDetectedSeal = Boolean(enteredUnknown || enteredSealed || confirmedSeal || sealed !== rawBody);
        return { sealed, visionDetectedSeal, confirmedSeal, detectedOnPage, explicitBoundary, reenteredSectionSealed, openedInlineAtEnd };
      };
      const reconcileEndSealState = (
        target: SealState,
        options: {
          hasNativeText: boolean;
          doclingEndSeal?: PdfSealMode;
          incomingSeal: SealState;
          nativeOutSeal: SealState;
          visionOutSeal?: SealState;
          visionReenteredSection?: boolean;
          visionOpenedInlineAtEnd?: boolean;
        },
      ) => {
        const vision = options.visionOutSeal;
        const visionResolvedUnknown = options.nativeOutSeal.unknownAfterFailure && vision && !vision.unknownAfterFailure;
        const picked = options.hasNativeText && !visionResolvedUnknown ? options.nativeOutSeal : vision ?? options.nativeOutSeal;
        Object.assign(target, picked);
        if (options.hasNativeText && options.visionOutSeal?.mode === "section_sealed") {
          const enteredNewSection = options.incomingSeal.mode !== "section_sealed" || Boolean(options.visionReenteredSection);
          if (enteredNewSection) {
            target.mode = "section_sealed";
            target.inWorkedExample = false;
            target.afterAllSealedPage = false;
          }
        }
        if (target.mode === "none" && !target.unknownAfterFailure && vision && !vision.unknownAfterFailure
          && options.nativeOutSeal.inWorkedExample === options.incomingSeal.inWorkedExample) {
          target.inWorkedExample = vision.inWorkedExample;
        }
        if (target.mode !== "section_sealed" && vision?.mode === "inline_sealed"
          && (options.incomingSeal.mode !== "inline_sealed" || options.visionOpenedInlineAtEnd)) {
          target.mode = "inline_sealed";
          target.inWorkedExample = false;
          target.afterAllSealedPage = false;
        }
        if (options.doclingEndSeal && (options.doclingEndSeal === "section_sealed" || target.mode !== "section_sealed")) {
          target.mode = options.doclingEndSeal;
          target.inWorkedExample = false;
          target.afterAllSealedPage = false;
          if (target.mode === "section_sealed") target.unknownAfterFailure = false;
        }
      };
      const sealVisionText = (
        rawVisionText: string,
        sealState: SealState,
        nativeContaminated: boolean,
        nativePublicPrefix?: string,
        requireExplicitBoundary = true,
      ) => {
        const boundTranscription = (transcription: string, explicitBoundary: boolean) => {
          if (nativePublicPrefix === undefined) return transcription;
          if (requireExplicitBoundary && !explicitBoundary) return "";
          const normalize = (line: string) => line.trim().replace(/\s+/gu, " ");
          const nativeLines = nativePublicPrefix.split(/\r?\n/u).map(normalize).filter(Boolean);
          const verified: string[] = [];
          let nextNativeLine = 0;
          for (const line of transcription.split(/\r?\n/u)) {
            const normalized = normalize(line);
            if (normalized) {
              const match = nativeLines.indexOf(normalized, nextNativeLine);
              if (match === -1) break;
              nextNativeLine = match + 1;
            }
            verified.push(line);
          }
          return verified.join("\n").trimEnd();
        };
        const headerRe = /^(【(?:原图忠实转写，尚需核对|图表观察描述，非原文或解答|识别不确定，不能据此判定正确)】|\[(?:转写|图片描述|图像描述|图示与版面描述|不确定处)\])[ \t]*[:：]?[ \t]*(?:\r?\n)?/gmu;
        const matches = [...rawVisionText.matchAll(headerRe)];
        const transcriptionSeed = { ...sealState };
        const incomingMode = sealState.mode;
        const enteredSealed = incomingMode === "section_sealed" || sealState.afterAllSealedPage;
        const anyNativeOrIncomingSeal = nativeContaminated || incomingMode !== "none" || enteredSealed || Boolean(sealState.unknownAfterFailure);
        // A late answer marker cannot establish the provenance of earlier lines.
        const requirePublicHeading = nativeContaminated && incomingMode === "none" && !sealState.unknownAfterFailure;
        if (matches.length === 0) {
          const { sealed, visionDetectedSeal, confirmedSeal, detectedOnPage, explicitBoundary, reenteredSectionSealed, openedInlineAtEnd } =
            sealVisionBodyWithTransitions(rawVisionText, sealState, requirePublicHeading);
          const transcription = boundTranscription(detectedOnPage && !requirePublicHeading
            ? stripSealedSolutionLines(rawVisionText, transcriptionSeed, undefined, true)
            : sealed, explicitBoundary);
          return {
            text: transcription,
            transcription,
            hasPublicTranscription: hasVerifiedPageText(transcription),
            hadSealedContent: anyNativeOrIncomingSeal || visionDetectedSeal,
            confirmedSeal,
            detectedOnPage,
            reenteredSectionSealed,
            openedInlineAtEnd,
          };
        }
        const transcriptions: string[] = [];
        const descriptions: string[] = [];
        const uncertainties: string[] = [];
        for (let i = 0; i < matches.length; i++) {
          const match = matches[i]!;
          const header = match[1]!;
          const bodyStart = (match.index ?? 0) + match[0].length;
          const bodyEnd = i + 1 < matches.length ? (matches[i + 1]!.index ?? rawVisionText.length) : rawVisionText.length;
          const body = rawVisionText.slice(bodyStart, bodyEnd).replace(/(?:\r?\n)+$/u, "");
          if (!body.trim()) continue;
          if (header === VISION_TRANSCRIPTION_HEADER || header === "[转写]") transcriptions.push(body);
          else if (header === VISION_UNCERTAINTIES_HEADER || header === "[不确定处]") uncertainties.push(body);
          else descriptions.push(body);
        }
        const transcription = transcriptions.join("\n");
        const primary = transcription
          ? sealVisionBodyWithTransitions(transcription, sealState, requirePublicHeading) : undefined;
        let hadSealedContent = anyNativeOrIncomingSeal || Boolean(primary?.visionDetectedSeal);
        let confirmedSeal = primary?.confirmedSeal ?? incomingMode !== "none";
        let detectedOnPage = Boolean(primary?.detectedOnPage);
        let reenteredSectionSealed = Boolean(primary?.reenteredSectionSealed);
        let openedInlineAtEnd = Boolean(primary?.openedInlineAtEnd);
        for (const body of [...descriptions, ...uncertainties]) {
          const auxiliarySeal = { ...sealState };
          const check = sealVisionBodyWithTransitions(body, auxiliarySeal, false);
          hadSealedContent ||= check.visionDetectedSeal;
          confirmedSeal ||= check.confirmedSeal;
          detectedOnPage ||= check.detectedOnPage;
          // Auxiliary text can introduce a seal, but only a transcription can release one.
          if (auxiliarySeal.mode !== "none" && (sealState.mode !== "section_sealed" || auxiliarySeal.mode === "section_sealed")) {
            Object.assign(sealState, auxiliarySeal);
            reenteredSectionSealed ||= check.reenteredSectionSealed;
            openedInlineAtEnd ||= check.openedInlineAtEnd;
          }
        }
        // An auxiliary answer label cannot establish where a transcription's public text ends.
        const publicTranscription = boundTranscription(
          transcription && detectedOnPage && (!requirePublicHeading || !primary?.detectedOnPage)
            ? stripSealedSolutionLines(transcription, transcriptionSeed, undefined, primary?.detectedOnPage ? true : "heading-only")
            : primary?.sealed ?? "",
          Boolean(primary?.explicitBoundary),
        );
        const parts = publicTranscription.trim() ? [`${VISION_TRANSCRIPTION_HEADER}\n${publicTranscription}`] : [];
        if (!hadSealedContent) {
          if (descriptions.length) parts.push(`${VISION_DESCRIPTION_HEADER}\n${descriptions.join("\n\n")}`);
          if (parts.length && uncertainties.length) parts.push(`${VISION_UNCERTAINTIES_HEADER}\n${uncertainties.join("\n\n")}`);
        }
        return { text: parts.join("\n\n"), transcription: publicTranscription, hasPublicTranscription: hasVerifiedPageText(publicTranscription), hadSealedContent, confirmedSeal, detectedOnPage, reenteredSectionSealed, openedInlineAtEnd };
      };
      const sanitizeSavedChunk = (
        saved: NewSourceChunk,
        page: ParsedPage,
        { incomingSeal, nativeOutSeal, doclingEndSeal, nativeContaminatedOnPage, hadNativeSeal, hasVisualInput }: {
          incomingSeal: SealState; nativeOutSeal: SealState; doclingEndSeal?: PdfSealMode;
          nativeContaminatedOnPage: boolean; hadNativeSeal: boolean; hasVisualInput: boolean;
        },
      ): { sanitized: NewSourceChunk | undefined; savedSeal: SealState; hasVisionMarker: boolean;
        hasPublicTranscription?: boolean; visionWasSealed: boolean; visionDetectedOnPage?: boolean } => {
        const anyNativeOrIncomingSeal = nativeContaminatedOnPage || incomingSeal.mode !== "none";
        const savedSeal: SealState = { ...nativeOutSeal };
        const { nativeBody: archivedNative, nativeHeader, vision, marker } = splitPdfChunk(saved.text);
        const legacyVision = !marker && !nativeHeader && Boolean(saved.imageObjectKey?.trim());
        if (!marker && !legacyVision) {
          if (!anyNativeOrIncomingSeal && (!saved.text.trim() || sealTextWithState(saved.text, { ...incomingSeal }) === saved.text)) {
            return { sanitized: saved, savedSeal, hasVisionMarker: false, visionWasSealed: false };
          }
          return {
            sanitized: page.text.trim() ? { ...saved, text: page.text, imageObjectKey: null } : undefined,
            savedSeal,
            hasVisionMarker: false,
            visionWasSealed: false,
          };
        }

        const nativeBody = legacyVision ? "" : archivedNative;
        const visionBody = legacyVision ? saved.text : vision;
        const cachedNativeOutSeal: SealState = { ...incomingSeal };
        const sealedNativeBody = nativeBody.trim() ? sealTextWithState(nativeBody, cachedNativeOutSeal) : "";
        const savedNativeChanged = sealedNativeBody !== nativeBody;
        const pageContaminated = nativeContaminatedOnPage || savedNativeChanged;
        const pageHadAnySeal = anyNativeOrIncomingSeal || savedNativeChanged;
        const visionSeal: SealState = { ...incomingSeal };
        const visionSealed = visionBody.trim()
          ? sealVisionText(visionBody, visionSeal, pageContaminated, hadNativeSeal || savedNativeChanged ? page.text : undefined)
          : { text: "", hasPublicTranscription: false, hadSealedContent: false, confirmedSeal: false, detectedOnPage: false, reenteredSectionSealed: false, openedInlineAtEnd: false };
        const sealedVisionBody = visionSealed.text;
        const pageHadSealed = pageHadAnySeal || visionSealed.hadSealedContent;
        const native = pageHadAnySeal ? page.text : sealedNativeBody;
        const publicNative = visionSealed.detectedOnPage
          ? stripSealedSolutionLines(native, { ...incomingSeal, mode: "none" }, undefined, pageHadAnySeal ? true : "heading-only")
          : native;
        reconcileEndSealState(savedSeal, {
          hasNativeText: Boolean(publicNative.trim()),
          doclingEndSeal,
          incomingSeal,
          nativeOutSeal: pageHadAnySeal ? nativeOutSeal : cachedNativeOutSeal,
          visionOutSeal: visionBody.trim() ? visionSeal : undefined,
          visionReenteredSection: visionSealed.reenteredSectionSealed,
          visionOpenedInlineAtEnd: visionSealed.openedInlineAtEnd,
        });
        // A native-only retry can retain the archived seal without republishing a Vision-only prefix.
        if (!sealedVisionBody.trim() || (!hasVisualInput && visionSealed.detectedOnPage && !publicNative.trim())) {
          return {
            sanitized: publicNative.trim() ? { ...saved, text: publicNative, imageObjectKey: null } : undefined,
            savedSeal,
            hasVisionMarker: pageHadSealed, visionWasSealed: visionSealed.confirmedSeal,
            visionDetectedOnPage: visionSealed.detectedOnPage,
          };
        }
        const currentNativeHeader = page.visualKinds?.includes("scan") ? "[本地提取（可能含OCR）]\n" : "[原生提取]\n";
        const rebuilt = legacyVision && !pageHadSealed && sealedVisionBody === saved.text.trimEnd()
          ? saved.text
          : publicNative.trim()
            ? `${pageHadAnySeal ? currentNativeHeader : (nativeHeader || "[原生提取]\n")}${publicNative}\n\n[视觉转写与描述]\n${sealedVisionBody}`
            : `[视觉转写与描述]\n${sealedVisionBody}`;
        const nextImageKey = pageHadSealed ? null : saved.imageObjectKey;
        return {
          sanitized: rebuilt === saved.text && nextImageKey === saved.imageObjectKey ? saved : { ...saved, text: rebuilt, imageObjectKey: nextImageKey },
          savedSeal,
          hasVisionMarker: true, hasPublicTranscription: visionSealed.hasPublicTranscription, visionWasSealed: visionSealed.confirmedSeal,
          visionDetectedOnPage: visionSealed.detectedOnPage,
        };
      };
      const preparePage = (rawPage: AnnotatedParsedPage, saved: NewSourceChunk | undefined, sealState: SealState,
        doclingIncomingSeal?: PdfSealMode, doclingIncomingWorkedExample?: boolean) => {
        const hadRawText = Boolean(rawPage.text.trim());
        const doclingSealedBlank = isPdf && rawPage.text === "" && Array.isArray(rawPage.visualKinds) && rawPage.visualKinds.length === 0;
        const closedInlineAnswer = rawPage.inlineSealedAtEnd === false && !rawPage.sectionSealedAtEnd;
        if (doclingSealedBlank && sealState.mode === "none") {
          if (!closedInlineAnswer) sealState.afterAllSealedPage = true;
          sealState.inWorkedExample = false;
        }
        const incomingSeal: SealState = { ...sealState };
        const nativeOutSeal: SealState = { ...incomingSeal };
        // Docling already removed the sealed prefix with this same input state.
        // Keep worker-only seals in effect and still scan the remaining text.
        if (doclingIncomingSeal && doclingIncomingSeal === incomingSeal.mode
          && rawPage.hadSealedContent && rawPage.inlineSealedAtEnd !== undefined) {
          nativeOutSeal.mode = "none";
        }
        let nativeDetectedSeal = false;
        const publicText = !isImage
          ? sealTextWithState(rawPage.text, nativeOutSeal, rawPage.page, rawPage.discourseBlocks,
            (_, nextMode) => { nativeDetectedSeal ||= nextMode !== "none"; })
          : rawPage.text;
        const doclingHadSealedContent = !isImage && Boolean(rawPage.hadSealedContent);
        if (doclingIncomingWorkedExample === incomingSeal.inWorkedExample
          && nativeOutSeal.inWorkedExample === incomingSeal.inWorkedExample && !nativeOutSeal.unknownAfterFailure
          && nativeOutSeal.mode === "none" && (hadRawText || doclingHadSealedContent)) {
          nativeOutSeal.inWorkedExample = Boolean(rawPage.inWorkedExampleAtEnd);
        }
        // With no native fragments, the end flag only echoes Docling's incoming seal.
        const doclingEndSeal = isPdf && (hadRawText || doclingHadSealedContent || doclingSealedBlank)
          ? pdfPageEndSeal(rawPage)
          : undefined;
        const pageHadNativeSeal = doclingHadSealedContent || doclingEndSeal !== undefined;
        const nativeContaminatedOnPage = !isImage && (
          doclingSealedBlank
          || publicText !== rawPage.text
          || pageHadNativeSeal
        );
        const withheldAfterFailure = Boolean(incomingSeal.unknownAfterFailure && hadRawText && !publicText.trim());
        const sealedAllText = !isImage && ((hadRawText && !publicText.trim() && !withheldAfterFailure)
          || doclingSealedBlank || (pageHadNativeSeal && !publicText.trim()));
        const page: ParsedPage = publicText === rawPage.text ? rawPage : { ...rawPage, text: publicText };
        const visualKinds = sealedAllText
          ? []
          : page.visualKinds !== undefined
            ? page.visualKinds
            : !hadRawText && (isImage || isPdf)
              ? ["scan" as const]
              : [];
        const visual = (isPdf || isImage) && visualKinds.length > 0
          ? { scope, job, sourceId: source.id, sourceVersion: source.version, physicalPage: page.page,
            nativeText: page.text, visualKinds, localFilePath: temp, mime: source.mime, signal }
          : undefined;
        let sanitizedSaved: NewSourceChunk | undefined;
        let savedSeal: SealState | undefined;
        let savedHasVision = false;
        let savedHasTranscription = false;
        let savedVisionWasSealed = false;
        let savedVisionDetectedOnPage = false;
        const hadNativeSeal = pageHadNativeSeal || nativeDetectedSeal || (hadRawText && !incomingSeal.unknownAfterFailure && publicText !== rawPage.text);
        if (saved && !isImage) {
          const cleaned = sanitizeSavedChunk(saved, page, {
            incomingSeal, nativeOutSeal, doclingEndSeal, nativeContaminatedOnPage, hadNativeSeal, hasVisualInput: Boolean(visual),
          });
          sanitizedSaved = sealedAllText || incomingSeal.unknownAfterFailure ? undefined : cleaned.sanitized;
          savedSeal = cleaned.savedSeal;
          savedHasVision = cleaned.hasVisionMarker;
          savedHasTranscription = Boolean(cleaned.hasPublicTranscription);
          savedVisionWasSealed = cleaned.visionWasSealed;
          savedVisionDetectedOnPage = Boolean(cleaned.visionDetectedOnPage);
        } else if (!incomingSeal.unknownAfterFailure) {
          sanitizedSaved = saved;
        }
        // Recheck raw Vision for pages published without an image key to restore trailing seals.
        const reusable = sanitizedSaved
          && (!visual || (Boolean(sanitizedSaved.imageObjectKey)
            && (!needsVerifiedImage(visual.visualKinds) || savedHasTranscription || hasVerifiedPageText(page.text))))
          ? sanitizedSaved
          : undefined;
        if (reusable && !isImage && savedSeal && savedHasVision) {
          Object.assign(sealState, savedSeal);
        } else {
          reconcileEndSealState(sealState, { hasNativeText: hadRawText, doclingEndSeal, incomingSeal, nativeOutSeal });
          // Archived text may be unusable even when it establishes a seal.
          if ((sealedAllText || incomingSeal.unknownAfterFailure) && savedVisionDetectedOnPage && savedSeal && savedSeal.mode !== "none"
            && (sealState.mode === "none" || (sealState.mode === "inline_sealed" && savedSeal.mode === "section_sealed"))) {
            Object.assign(sealState, savedSeal);
          }
        }
        return {
          page,
          hadRawText,
          visual,
          originalSaved: saved,
          saved: sanitizedSaved,
          reusable,
          sealedAllText,
          savedSeal,
          savedHasVision,
          savedHasTranscription,
          savedVisionWasSealed,
          savedVisionDetectedOnPage,
          nativeContaminatedOnPage,
          hadNativeSeal,
          nativeSealConfirmedOnPage: pageHadNativeSeal || nativeDetectedSeal || hadNativeSeal && incomingSeal.mode === "none",
          withheldAfterFailure,
          doclingEndSeal,
          incomingSeal,
          nativeOutSeal,
        };
      };
      const consumePage = async (
        {
          page,
          hadRawText,
          visual,
          saved,
          reusable,
          sealedAllText,
          savedSeal,
          savedHasVision,
          savedVisionWasSealed,
          nativeContaminatedOnPage,
          hadNativeSeal,
          withheldAfterFailure,
          doclingEndSeal,
          incomingSeal,
          nativeOutSeal,
        }: ReturnType<typeof preparePage>,
        liveSealState: SealState,
        recognizePage: ((input: ParseSourceVisualPageInput) => Promise<ParseSourceVisualPageResult | null>) | undefined =
          visualRecognitionUnavailable ? undefined : deps.recognizePage,
        evidence?: { visionHandled: boolean; visionTranscribed: boolean; visionHadSeal: boolean; visionDetectedOnPage: boolean; transcription: string },
      ): Promise<NewSourceChunk | undefined> => {
        signal.throwIfAborted();
        hasSealedContent ||= hadNativeSeal || savedVisionWasSealed;
        if (sealedAllText) return undefined;
        if (reusable) return reusable;
        let text = page.text;
        let imageObjectKey: string | null = null;
        let visionHandled = false;
        if (isImage && !deps.recognizePage) throw new Error(`visual recognition is required for physical page ${page.page}`);
        if (visual && recognizePage) {
          await assertCurrent?.();
          let result: ParseSourceVisualPageResult | null;
          try {
            result = await recognizePage(visual);
          } catch (error) {
            if (!(error instanceof OpeningModelRoutingError)) throw error;
            result = null;
          }
          signal.throwIfAborted();
          await assertCurrent?.();
          if (result === null) {
            visualRecognitionUnavailable = true;
          } else {
            if (!result || typeof result.text !== "string" || !result.text.trim() || typeof result.imageObjectKey !== "string" || !result.imageObjectKey.trim()) throw new Error(`visual recognition returned no readable content or image for physical page ${page.page}`);
            visionHandled = true;
            const visionSeal: SealState = { ...incomingSeal };
            const visionSealed = !isImage
              ? sealVisionText(result.text, visionSeal, nativeContaminatedOnPage, hadNativeSeal ? page.text : undefined)
              : { text: result.text, transcription: result.text, hasPublicTranscription: true, hadSealedContent: false, confirmedSeal: false, detectedOnPage: false, reenteredSectionSealed: false, openedInlineAtEnd: false };
            const sealedVisionText = visionSealed.text;
            const pageHadSealed = visionSealed.hadSealedContent;
            if (evidence) {
              evidence.visionHandled = true;
              evidence.visionTranscribed = visionSealed.hasPublicTranscription;
              evidence.transcription = visionSealed.transcription;
              evidence.visionHadSeal = pageHadSealed;
              evidence.visionDetectedOnPage = visionSealed.detectedOnPage;
            }
            hasSealedContent ||= visionSealed.confirmedSeal;
            reconcileEndSealState(liveSealState, {
              hasNativeText: hadRawText,
              doclingEndSeal,
              incomingSeal,
              nativeOutSeal,
              visionOutSeal: visionSeal,
              visionReenteredSection: visionSealed.reenteredSectionSealed,
              visionOpenedInlineAtEnd: visionSealed.openedInlineAtEnd,
            });
            if (visionSealed.detectedOnPage) {
              text = stripSealedSolutionLines(text, { ...incomingSeal, mode: "none" }, undefined, hadNativeSeal ? true : "heading-only");
            }
            const verifiedImageKey = pageHadSealed || (isPdf && needsVerifiedImage(visual.visualKinds)
              && !visionSealed.hasPublicTranscription && !hasVerifiedPageText(text)) ? null : result.imageObjectKey;
            if (!isImage && !sealedVisionText.trim()) {
              if (!text.trim()) {
                if (!pageHadSealed) skippedVisionPages.push(page.page);
                return undefined;
              }
            } else {
              const extractionLabel = visual.visualKinds.includes("scan") ? "本地提取（可能含OCR）" : "原生提取";
              const nativeHeader = text ? `[${extractionLabel}]\n` : "";
              const visionHeader = "[视觉转写与描述]\n";
              const nativeLength = text ? nativeHeader.length + text.length + 2 : 0;
              if (isPdf && nativeLength + visionHeader.length + sealedVisionText.length > PDF_CHUNK_TEXT_LIMIT) {
                cappedTextPages.add(page.page);
                if (saved?.text.trim() && !pageHadSealed) {
                  return saved;
                }
                if (!text.trim()) {
                  text = visionHeader + sealedVisionText;
                  imageObjectKey = verifiedImageKey;
                }
              } else {
                text = `${text ? `${nativeHeader}${text}\n\n` : ""}${visionHeader}${sealedVisionText}`;
                imageObjectKey = verifiedImageKey;
              }
            }
          }
        }
        if (!visionHandled && !isImage && savedSeal && savedHasVision) {
          Object.assign(liveSealState, savedSeal);
          if (savedVisionWasSealed) return saved;
        }
        if (isPdf && visual && !withheldAfterFailure && imageObjectKey === null && !visionHandled && !cappedTextPages.has(page.page)) {
          if (!saved || !savedHasVision) skippedVisionPages.push(page.page);
          if (saved) return saved;
        }
        if (isImage && visualRecognitionUnavailable) imageObjectKey = deps.storage.finalKey(source.id, source.version);
        if (text.trim() || imageObjectKey) return { page: page.page, slideLabel: null, startMs: null, endMs: null, text, imageObjectKey };
      };

      let pageCount: number;
      const publication = { sourceId: source.id, sourceVersion: source.version };
      if (isPdf) {
        const parserProfile = pdfParserProfile();
        const pageSealIdentity = (pageStart: number, pageEnd = pageStart) => ({
          ...publication, parserProfile: PAGE_SEAL_PROFILE, pageStart, pageEnd,
        });
        const readPageSeals = async (start: number, end: number) => {
          const pageSeals = new Map<number, PdfSegmentPage>();
          if (deps.segments?.readPageSeals) {
            for (const page of await deps.segments.readPageSeals(scope, pageSealIdentity(start, end))) {
              pageSeals.set(page.page, page);
            }
          } else if (deps.segments) {
            for (let page = start; page <= end; page++) {
              const record = await deps.segments.read(scope, pageSealIdentity(page));
              if (record?.state === "ready" && record.pages.length === 1 && record.pages[0]?.page === page) {
                pageSeals.set(page, record.pages[0]);
              }
            }
          }
          return pageSeals;
        };
        const publicationSeals = new Map<number, PdfSegmentPage>();
        const hasNewVisualSealEvidence = (marker: PdfSegmentPage | undefined, kinds: PdfSegmentPage["visualKinds"]) =>
          kinds !== undefined && (marker?.visualKinds === undefined
            || kinds.some(kind => !marker.visualKinds?.includes(kind)));
        const stagePageSeal = async (marker: PdfSegmentPage | undefined, next: PdfSegmentPage, republish = false) => {
          if (!deps.segments) return;
          publicationSeals.set(next.page, next);
          const previousMode = pdfPageEndSeal(marker);
          const nextMode = pdfPageEndSeal(next);
          const tighter = next.hadSealedContent && !marker?.hadSealedContent
            || next.hadSealedContent && hasNewVisualSealEvidence(marker, next.visualKinds)
            || next.publicationSealUnknown && !marker?.publicationSealUnknown
            || nextMode && nextMode !== previousMode && previousMode !== "section_sealed"
            || republish && marker?.publicationSealCommitted !== false;
          if (!tighter) return;
          const mode = previousMode === "section_sealed" ? previousMode : nextMode ?? previousMode;
          // Concurrent readers see every tightening immediately. A pending write cannot erase
          // older blocking evidence or publish a section reopening before the chunks commit.
          const pending = {
            ...next,
            hadSealedContent: Boolean(marker?.hadSealedContent || next.hadSealedContent),
            publicationSealHadPublicPrefix: marker?.hadSealedContent
              ? marker.publicationSealHadPublicPrefix : next.publicationSealHadPublicPrefix,
            publicationSealUnknown: Boolean(marker?.publicationSealUnknown || next.publicationSealUnknown),
            // An empty array records archived Vision evidence without current visual inputs.
            visualKinds: next.visualKinds ?? marker?.visualKinds,
            sectionSealedAtEnd: mode === "section_sealed",
            inlineSealedAtEnd: mode === "inline_sealed",
            publicationSealCommitted: false,
            reopenedSection: false,
          };
          await deps.segments.save(scope, pageSealIdentity(next.page), { state: "ready", pages: [pending] }, signal);
        };

        const beginsWithRecoveredPdfSection = (text: string) => {
          const { nativeBody, vision } = splitPdfChunk(text);
          return beginsWithRecoverySection(nativeBody || vision.replace(VISION_TRANSCRIPTION_HEADER, ""));
        };
        const inspectSavedPdfChunk = (chunk: NewSourceChunk, incomingSeal: SealState) => {
          const { nativeBody, nativeHeader, vision, marker } = splitPdfChunk(chunk.text);
          const legacyVision = !marker && !nativeHeader && chunk.imageObjectKey?.trim() ? nativeBody : "";
          const native = legacyVision ? "" : nativeBody;
          const nativeOutSeal = { ...incomingSeal };
          const nativeChanged = sealTextWithState(native, nativeOutSeal) !== native;
          const visionOutSeal = { ...incomingSeal };
          const visionText = vision || legacyVision;
          const visionCheck = visionText.trim() ? sealVisionText(visionText, visionOutSeal, nativeChanged) : undefined;
          const endSeal = { ...incomingSeal };
          reconcileEndSealState(endSeal, {
            hasNativeText: Boolean(native.trim()), incomingSeal, nativeOutSeal,
            visionOutSeal: visionCheck ? visionOutSeal : undefined,
            visionReenteredSection: visionCheck?.reenteredSectionSealed,
            visionOpenedInlineAtEnd: visionCheck?.openedInlineAtEnd,
          });
          const incomingContaminated = incomingSeal.mode !== "none" || incomingSeal.unknownAfterFailure;
          const unverifiedVision = Boolean((marker || legacyVision || chunk.imageObjectKey)
            && (!chunk.imageObjectKey?.trim() || !visionCheck?.hasPublicTranscription));
          if (unverifiedVision && endSeal.mode === "none") endSeal.unknownAfterFailure = true;
          const unsafe = nativeChanged || nativeOutSeal.mode !== "none" || Boolean(visionCheck?.hadSealedContent)
            || unverifiedVision || !hasVerifiedPageText(native) && !visionCheck?.hasPublicTranscription
            || Boolean(incomingContaminated && chunk.imageObjectKey);
          return { unsafe, endSeal };
        };
        const previousCappedPages = readCappedPdfPages(source.pdfTextCap ??
          (source.error?.code === "PARSE_PARTIAL" ? source.error.message : undefined));
        const lowQualityPages: number[] = [];
        const preservePages: number[] = [];
        const withheldAfterFailurePages: number[] = [];
        let usablePages = 0;
        const cleanSeal: SealState = { mode: "none", inWorkedExample: false, afterAllSealedPage: false };
        const pdfSealState = { ...cleanSeal };
        const unsafeLegacyPages = new Set<number>();
        const recognizePages = deps.recognizePages;
        const recognizeSingleFromBatch = recognizePages
          ? async (input: ParseSourceVisualPageInput): Promise<ParseSourceVisualPageResult | null> => {
              const single = recognizePages([input], visualRecognitionUnavailable);
              try {
                const next = await single.next();
                return next.done ? null : next.value;
              } finally {
                await single.return();
              }
            }
          : undefined;
        const stagePath = path.join(workDir, "chunks.ndjson");
        const stage = await open(stagePath, "wx", 0o600);
        const result = await parsePdfSegments({ path: temp, ...publication, scope, runner: deps.runner,
          segments: deps.segments, signal, parserProfile, segmentPages: deps.segmentPages, timeoutSeconds: deps.segmentTimeoutSeconds,
          shouldRevalidateSegment: async (start, end) =>
            [...(await readPageSeals(start, end)).values()].some(marker =>
              marker.hadSealedContent || marker.publicationSealUnknown || pdfPageEndSeal(marker)),
          onFailedSegment: async ({ pageStart, pageEnd, initialSealMode }) => {
            const pages = Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart + index);
            const existing = deps.segments
              ? await deps.chunks.listChunksAtVersion(scope, source.id, source.version, pages, { unpublishedPdfForRecovery: true })
              : [];
            const saved = new Map(existing.map(chunk => [chunk.page, chunk]));
            const pageSeals = await readPageSeals(pageStart, pageEnd);
            const blockingSeals: PdfSegmentPage[] = [];
            if (initialSealMode === "section_sealed" || pdfSealState.mode === "none" && initialSealMode) {
              pdfSealState.mode = initialSealMode;
            }
            for (const page of pages) {
              signal.throwIfAborted();
              const marker = pageSeals.get(page);
              const chunk = saved.get(page);
              const incomingUnresolved = pdfSealState.unknownAfterFailure || pdfSealState.mode !== "none";
              const check = chunk && inspectSavedPdfChunk(chunk, { ...pdfSealState });
              const sectionSealed = pdfSealState.mode === "section_sealed" || check?.endSeal.mode === "section_sealed"
                || marker?.sectionSealedAtEnd === true;
              const markedSealed = Boolean(marker?.hadSealedContent || marker?.publicationSealUnknown || pdfPageEndSeal(marker));
              const savedIsClean = Boolean(chunk?.text.trim() && check && !check.unsafe && !markedSealed);
              const preserve = savedIsClean && (!incomingUnresolved || (
                chunk && !chunk.imageObjectKey && beginsWithRecoveredPdfSection(chunk.text)
              ));
              if (preserve) {
                preservePages.push(page);
                if (previousCappedPages.has(page)) cappedTextPages.add(page);
              } else if (chunk) {
                withheldAfterFailurePages.push(page);
                unsafeLegacyPages.add(page);
              }
              // An archived chunk can justify retaining that citation, but a failed page
              // cannot clear inherited uncertainty about the original physical pages.
              Object.assign(pdfSealState, cleanSeal, {
                mode: sectionSealed ? "section_sealed" : "none",
                unknownAfterFailure: !sectionSealed && (incomingUnresolved || !savedIsClean),
              });
              if (!preserve) {
                blockingSeals.push({ page, text: "", imagePath: null, publicationSealUnknown: true });
                if (marker && !marker.failedRangeBoundary) publicationSeals.set(page, marker);
              }
            }
            return blockingSeals;
          },
          onPages: async (pages, initialDoclingSeal, _afterFailedSegment, initialDoclingWorkedExample, cached) => {
            const pageSeals = await readPageSeals(pages[0]!.page, pages.at(-1)!.page);
            const existing = deps.segments
              ? await deps.chunks.listChunksAtVersion(scope, source.id, source.version, pages.map(page => page.page), { unpublishedPdfForRecovery: true })
              : [];
            const published = new Map(existing.map(({ page, slideLabel, startMs, endMs, text, imageObjectKey }) =>
              [page, { page, slideLabel, startMs, endMs, text, imageObjectKey }]));
            const drySealState: SealState = { ...pdfSealState };
            let doclingIncomingSeal = initialDoclingSeal;
            let doclingIncomingWorkedExample = initialDoclingWorkedExample;
            const planned = pages.map(rawPage => {
              const seed = doclingIncomingSeal;
              const workedExample = doclingIncomingWorkedExample;
              const prep = preparePage(rawPage, published.get(rawPage.page), drySealState, seed, workedExample);
              doclingIncomingSeal = pdfPageEndSeal(rawPage);
              doclingIncomingWorkedExample = Boolean(rawPage.inWorkedExampleAtEnd);
              const marker = pageSeals.get(rawPage.page);
              const blocked = marker?.hadSealedContent || marker?.publicationSealUnknown || pdfPageEndSeal(marker);
              return { rawPage, doclingIncomingSeal: seed, workedExample, prepared: prep,
                visualInput: prep.visual && (!prep.reusable || blocked) ? prep.visual : undefined };
            });
            const visualInputs = planned.flatMap(({ visualInput }) => visualInput ? [visualInput] : []);
            let yieldedVisualCount = 0;
            let recognition: ReturnType<NonNullable<typeof recognizePages>> | undefined;
            const recognizePage = recognizePages ? async () => {
              recognition ??= recognizePages(visualInputs, visualRecognitionUnavailable);
              const next = await recognition.next();
              if (next.done) throw new Error("visual recognition batch ended before all pages were recognized");
              yieldedVisualCount++;
              return next.value;
            } : undefined;
            try {
              for (const [index, { rawPage, doclingIncomingSeal, workedExample, visualInput }] of planned.entries()) {
                signal.throwIfAborted();
                const actualSealMode = pdfSealState.unknownAfterFailure || pdfSealState.mode === "none" ? undefined : pdfSealState.mode;
                const actualWorkedExample = pdfSealState.inWorkedExample && !pdfSealState.unknownAfterFailure;
                if (index > 0 && (actualSealMode !== doclingIncomingSeal
                  || (workedExample !== undefined && workedExample !== actualWorkedExample))) {
                  // Docling may have filtered the remaining pages under a different context.
                  return { resumeFromPage: rawPage.page, nextSealMode: actualSealMode ?? null, nextInWorkedExample: actualWorkedExample };
                }
                const preparedPage = preparePage(rawPage, published.get(rawPage.page), pdfSealState, doclingIncomingSeal, workedExample);
                const marker = pageSeals.get(rawPage.page);
                const recordedMode = pdfPageEndSeal(marker);
                const previouslySealed = Boolean(marker?.hadSealedContent || recordedMode);
                const previouslyUnverified = Boolean(marker?.publicationSealUnknown);
                const previouslyBlocked = previouslySealed || previouslyUnverified;
                const evidence = { visionHandled: false, visionTranscribed: false, visionHadSeal: false, visionDetectedOnPage: false,
                  transcription: "" };
                let chunk: NewSourceChunk | undefined;
                let implicatedVisualPages = new Set<number>();
                try {
                  let prefetched: { value: ParseSourceVisualPageResult | null } | undefined;
                  if (visualInput && recognizePage) {
                    // The first pull of each render batch can fail while preparing any page in it.
                    const batchSize = yieldedVisualCount % MAX_PDF_RENDER_PAGES === 0 ? MAX_PDF_RENDER_PAGES : 1;
                    implicatedVisualPages = new Set(visualInputs.slice(yieldedVisualCount, yieldedVisualCount + batchSize)
                      .map(input => input.physicalPage));
                    try {
                      prefetched = { value: await recognizePage() };
                    } catch (error) {
                      if (!(error instanceof OpeningModelRoutingError)) throw error;
                      prefetched = { value: null };
                    }
                    implicatedVisualPages = new Set([rawPage.page]);
                  }
                  const effectivePrepared = previouslyBlocked || (preparedPage.visual && prefetched?.value)
                    ? { ...preparedPage, reusable: undefined }
                    : preparedPage;
                  const singlePageRecognition = visualRecognitionUnavailable
                    ? recognizeSingleFromBatch
                    : deps.recognizePage ?? recognizeSingleFromBatch;
                  const pageRecognize = prefetched ? async () => prefetched.value : visualInput ? undefined : singlePageRecognition;
                  if (visualInput || (effectivePrepared.visual && !effectivePrepared.reusable && pageRecognize)) {
                    implicatedVisualPages.add(rawPage.page);
                  }
                  chunk = await consumePage(effectivePrepared, pdfSealState, pageRecognize, evidence);
                } catch (error) {
                  const cancelled = signal.aborted || error instanceof Error
                    && (error.name === "AbortError" || ("code" in error && error.code === "CONFLICT"));
                  if (!cancelled) {
                    for (let failedIndex = index; failedIndex < planned.length; failedIndex++) {
                      const failed = planned[failedIndex]!;
                      const { rawPage: page } = failed;
                      const prepared = failedIndex === index ? preparedPage : failed.prepared;
                      const visualKinds = (prepared.visual ?? failed.visualInput)?.visualKinds ?? page.visualKinds;
                      const endSeal = pdfPageEndSeal(page);
                      // A later page can inherit a fence from an earlier marker without opening its own seal.
                      const nativeConfirmed = prepared.nativeSealConfirmedOnPage || Boolean(page.hadSealedContent || endSeal)
                        || (failedIndex === index && prepared.hadNativeSeal);
                      const archivedConfirmed = prepared.savedVisionDetectedOnPage || prepared.savedVisionWasSealed;
                      const savedVisionMode = archivedConfirmed ? prepared.savedSeal?.mode : undefined;
                      const confirmed = nativeConfirmed || archivedConfirmed;
                      const unknown = implicatedVisualPages.has(page.page)
                        && Boolean(visualKinds && needsVerifiedImage(visualKinds) && !hasVerifiedPageText(page.text));
                      if (!confirmed && !unknown) continue;
                      const endModes = [endSeal, prepared.nativeOutSeal.mode, savedVisionMode];
                      const section = confirmed && endModes.includes("section_sealed");
                      const inline = confirmed && !section && endModes.includes("inline_sealed");
                      const hasPublicPrefix = Boolean((nativeConfirmed && prepared.page.text.trim())
                        || (archivedConfirmed && prepared.saved?.text.trim()));
                      const previousMarker = pageSeals.get(page.page);
                      const hasVisualProvenance = archivedConfirmed || unknown || previousMarker?.visualKinds !== undefined;
                      const markerVisualKinds = hasVisualProvenance
                        ? (prepared.visual ?? failed.visualInput)?.visualKinds ?? previousMarker?.visualKinds ?? []
                        : undefined;
                      await stagePageSeal(previousMarker, {
                        page: page.page, text: "", imagePath: null, visualKinds: markerVisualKinds, hadSealedContent: confirmed,
                        ...(confirmed ? { publicationSealHadPublicPrefix: hasPublicPrefix } : {}),
                        sectionSealedAtEnd: section, inlineSealedAtEnd: inline, publicationSealUnknown: unknown,
                      }, true);
                    }
                  }
                  throw error;
                }
                const visualSeal = evidence.visionHandled ? evidence.visionDetectedOnPage : preparedPage.savedVisionDetectedOnPage;
                const visualSealKinds = visualSeal ? preparedPage.visual?.visualKinds ?? marker?.visualKinds ?? [] : undefined;
                const confirmedSeal = preparedPage.nativeSealConfirmedOnPage || visualSeal;
                const onlyUncertainty = previouslyUnverified && !previouslySealed;
                const verifiedNativeRecovery = !cached && preparedPage.hadRawText && !preparedPage.visual
                  && (onlyUncertainty || !preparedPage.savedHasVision)
                  && (onlyUncertainty || marker?.visualKinds === undefined) && marker?.publicationSealHadPublicPrefix !== true
                  && (isStandaloneRecoverySection(rawPage.text)
                    || onlyUncertainty && !preparedPage.incomingSeal.unknownAfterFailure
                      && preparedPage.incomingSeal.mode === "none" && isStandaloneRecoveryProse(rawPage.text));
                const recoveredVision = previouslyBlocked && evidence.visionTranscribed && !evidence.visionDetectedOnPage
                  && (!previouslySealed || !evidence.visionHadSeal) && chunk
                  ? splitPdfChunk(chunk.text) : undefined;
                const recoveryTranscription = recoveredVision ? evidence.transcription : "";
                const cleanVision = previouslySealed
                  ? marker?.visualKinds !== undefined && marker.publicationSealHadPublicPrefix === false
                    && isStandaloneRecoverySection(recoveryTranscription)
                  : isStandaloneRecoverySection(recoveryTranscription) || (
                    !evidence.visionHadSeal && preparedPage.incomingSeal.mode === "none"
                    && !preparedPage.incomingSeal.unknownAfterFailure && isStandaloneRecoveryProse(recoveryTranscription)
                  );
                const recoveredNative = onlyUncertainty && verifiedNativeRecovery && !confirmedSeal;
                if (recoveredNative) {
                  reconcileEndSealState(pdfSealState, { ...preparedPage, hasNativeText: true });
                }
                const verifiedRecovery = (verifiedNativeRecovery || cleanVision) && !confirmedSeal
                  && pdfSealState.mode === "none" && !pdfSealState.unknownAfterFailure;
                const replayMarker = previouslyBlocked && !verifiedRecovery;
                if (replayMarker) {
                  if (onlyUncertainty && skippedVisionPages.at(-1) !== rawPage.page) skippedVisionPages.push(rawPage.page);
                  hasSealedContent ||= previouslySealed;
                  if (recordedMode === "section_sealed" || recordedMode === "inline_sealed" && pdfSealState.mode === "none" && !pdfSealState.unknownAfterFailure) {
                    Object.assign(pdfSealState, cleanSeal, { mode: recordedMode });
                  } else if (previouslyUnverified && pdfSealState.mode === "none") {
                    Object.assign(pdfSealState, cleanSeal, { unknownAfterFailure: true });
                  }
                  const verifiedNative = preparedPage.page.text;
                  if (previouslySealed ? marker?.publicationSealHadPublicPrefix !== true : !beginsWithRecoverySection(verifiedNative)) {
                    chunk = undefined;
                  } else if (chunk) {
                    const { nativeHeader, vision } = splitPdfChunk(chunk.text);
                    const native = previouslySealed && preparedPage.hadNativeSeal ? verifiedNative
                      : stripSealedSolutionLines(verifiedNative, { ...cleanSeal }, undefined, "heading-only");
                    const publicVision = previouslySealed && vision && native.trim()
                      ? sealVisionText(vision, { ...cleanSeal }, true, native, false).text : "";
                    const text = publicVision
                      ? [native && nativeHeader + native, "[视觉转写与描述]\n" + publicVision].filter(Boolean).join("\n\n")
                      : native;
                    chunk = text.trim() ? { ...chunk, text, imageObjectKey: null } : undefined;
                  }
                } else if (verifiedRecovery && recoveredNative) {
                  chunk = { page: rawPage.page, slideLabel: null, startMs: null, endMs: null,
                    text: preparedPage.page.text, imageObjectKey: null };
                } else if (verifiedRecovery && recoveredVision && chunk) {
                  // The verified transcription cannot vouch for unheaded text from a separate native extraction.
                  const native = stripSealedSolutionLines(recoveredVision.nativeBody, { ...cleanSeal }, undefined, "heading-only");
                  const vision = "[视觉转写与描述]\n" + recoveredVision.vision;
                  chunk = { ...chunk, text: native ? recoveredVision.nativeHeader + native + "\n\n" + vision : vision };
                }
                const unverifiedImage = preparedPage.visual && needsVerifiedImage(preparedPage.visual.visualKinds);
                const unverifiedPage = !confirmedSeal && !previouslySealed && pdfSealState.mode === "none"
                  && !(evidence.visionTranscribed || preparedPage.savedHasTranscription && chunk?.imageObjectKey)
                  && !preparedPage.sealedAllText
                  && ((unverifiedImage && !hasVerifiedPageText(rawPage.text))
                    || (Boolean(rawPage.text.trim()) && checkPdfPageQuality(rawPage.text).quality === "low_quality"));
                if (unverifiedPage) {
                  // Keep Docling's raw extractions usable for recovery. The worker carries the unknown boundary across ranges.
                  Object.assign(pdfSealState, cleanSeal, { unknownAfterFailure: true });
                  if (unverifiedImage && skippedVisionPages.at(-1) !== rawPage.page) skippedVisionPages.push(rawPage.page);
                }
                if (chunk?.imageObjectKey && (confirmedSeal || pdfSealState.mode !== "none" || pdfSealState.unknownAfterFailure)) {
                  chunk = { ...chunk, imageObjectKey: null };
                }
                if (preparedPage.originalSaved && (previouslyBlocked || preparedPage.hadNativeSeal || confirmedSeal || unverifiedPage
                  || preparedPage.incomingSeal.unknownAfterFailure || preparedPage.saved !== preparedPage.originalSaved)) {
                  unsafeLegacyPages.add(rawPage.page);
                }
                const strongerSeal = confirmedSeal && (previouslyUnverified || hasNewVisualSealEvidence(marker, visualSealKinds) || (
                  pdfSealState.mode !== "none" && pdfSealState.mode !== recordedMode && recordedMode !== "section_sealed"
                ));
                const publicPrefix = chunk?.text.trim() ? true : previouslySealed ? marker?.publicationSealHadPublicPrefix : false;
                const recoveredSection = verifiedRecovery && (beginsWithRecoverySection(recoveryTranscription)
                  || isStandaloneRecoverySection(rawPage.text));
                const reopenedSection = !replayMarker && Boolean(chunk?.text.trim()) && pdfSealState.mode === "none"
                  && !pdfSealState.unknownAfterFailure && (recoveredSection || preparedPage.incomingSeal.mode !== "none"
                    || preparedPage.incomingSeal.unknownAfterFailure);
                if ((!replayMarker && (confirmedSeal || unverifiedPage || previouslyBlocked || reopenedSection)) || strongerSeal) {
                  await stagePageSeal(marker, {
                    page: rawPage.page, text: "", imagePath: null, hadSealedContent: confirmedSeal,
                    ...(confirmedSeal && publicPrefix !== undefined ? { publicationSealHadPublicPrefix: publicPrefix } : {}),
                    ...(unverifiedPage || replayMarker && previouslyUnverified && pdfSealState.unknownAfterFailure
                      ? { publicationSealUnknown: true } : {}),
                    // Retain visual provenance when the current evidence only strengthens the existing seal.
                    ...(visualSealKinds !== undefined || unverifiedPage && unverifiedImage || replayMarker && marker?.visualKinds !== undefined
                      ? { visualKinds: visualSealKinds ?? preparedPage.visual?.visualKinds ?? marker?.visualKinds ?? [] } : {}),
                    ...(pdfSealState.mode === "section_sealed" ? { sectionSealedAtEnd: true }
                      : pdfSealState.mode === "inline_sealed" ? { inlineSealedAtEnd: true } : {}),
                    ...(reopenedSection ? { reopenedSection: true } : {}),
                  });
                } else if (replayMarker && marker && !marker.failedRangeBoundary) {
                  publicationSeals.set(rawPage.page, marker);
                }
                if (!chunk) {
                  if (preparedPage.withheldAfterFailure || (
                    (preparedPage.incomingSeal.unknownAfterFailure || replayMarker) && preparedPage.originalSaved
                  )) {
                    withheldAfterFailurePages.push(rawPage.page);
                    if (checkPdfPageQuality(rawPage.text).quality === "low_quality") lowQualityPages.push(rawPage.page);
                  }
                  continue;
                }
                const { page, text: nativeText } = preparedPage.page;
                if ((chunk === preparedPage.saved || chunk === preparedPage.originalSaved) &&
                  (previousCappedPages.has(page) ||
                    (nativeText.length > PDF_CHUNK_TEXT_LIMIT && chunk.text.length <= PDF_CHUNK_TEXT_LIMIT))) {
                  cappedTextPages.add(page);
                }
                if (chunk.text.length > PDF_CHUNK_TEXT_LIMIT) {
                  if (chunk === preparedPage.originalSaved) {
                    // Existing rows can fit PostgreSQL's code-point limit but exceed the UTF-16 bound.
                    preservePages.push(page);
                    if (checkPdfPageQuality(chunk.text).quality === "low_quality") lowQualityPages.push(page);
                    usablePages++;
                    continue;
                  }
                  cappedTextPages.add(page);
                  const text = chunk.text.slice(0, PDF_CHUNK_TEXT_LIMIT).replace(/[\uD800-\uDBFF]$/u, "");
                  if (!text.trim() && !chunk.imageObjectKey) continue;
                  chunk = { ...chunk, text };
                }
                if (checkPdfPageQuality(chunk.text).quality === "low_quality") lowQualityPages.push(page);
                await stage.appendFile(`${JSON.stringify(chunk)}\n`, "utf8");
                usablePages++;
              }
            } finally { await recognition?.return(); }
            return {
              nextSealMode: pdfSealState.unknownAfterFailure || pdfSealState.mode === "none" ? null : pdfSealState.mode,
              nextInWorkedExample: !pdfSealState.unknownAfterFailure && pdfSealState.inWorkedExample,
            };
          },
        }).finally(() => stage.close());
        pageCount = result.pageCount;
        if (!pageCount && !withheldAfterFailurePages.length) {
          throw new ConversionFailedError(`PDF segments failed (${result.failedRanges.join(", ")})`);
        }
        const failedRanges = [...result.failedRanges, ...skippedVisionPages.map(String)];
        const pdfTextCap = [...cappedTextPages];
        const warning = failedRanges.length || lowQualityPages.length || pdfTextCap.length
          ? { ...createPdfPartialError(failedRanges, lowQualityPages, pdfTextCap), ...(pdfTextCap.length ? { pdfTextCap } : {}) }
          : null;
        const allowSealedEmpty = !usablePages && (hasSealedContent || withheldAfterFailurePages.length > 0);
        if (warning && !usablePages && !allowSealedEmpty) throw new Error(warning.message);
        signal.throwIfAborted();
        await assertCurrent?.();
        await deps.chunks.replacePdfChunks(scope, { ...publication, chunks: readStagedPdfChunks(stagePath, signal), preservePages,
          ...(unsafeLegacyPages.size ? { unsafeLegacyPages: [...unsafeLegacyPages] } : {}),
          ...(publicationSeals.size ? { publicationSeals: [...publicationSeals.values()] } : {}),
          ...(warning ? { warning } : {}), ...(allowSealedEmpty ? { allowSealedEmpty: true } : {}) });
      } else {
        const pages: ParsedPage[] = isImage ? [{ page: 1, text: "", imagePath: null, visualKinds: ["scan"] }]
          : await parser.parseDocument({ path: temp, mime: source.mime, maxPages: 2000 }, signal);
        pageCount = pages.length;
        const docSealState: SealState = { mode: "none", inWorkedExample: false, afterAllSealedPage: false };
        const chunks: NewSourceChunk[] = [];
        for (const page of pages) {
          const chunk = await consumePage(preparePage(page, undefined, docSealState), docSealState);
          if (chunk) chunks.push(chunk);
        }
        signal.throwIfAborted();
        await assertCurrent?.();
        await deps.chunks.replaceChunks(scope, { ...publication, chunks,
          ...(!chunks.length && hasSealedContent ? { allowSealedEmpty: true } : {}) });
      }
      if (deps.onSourceReady) {
        try { await deps.onSourceReady(scope, { sourceId: source.id, sourceVersion: source.version }); } catch { /* best-effort */ }
      }
      if (isImage) return { pages: 1, imageOnly: visualRecognitionUnavailable };
      return { pages: pageCount, ...(skippedVisionPages.length ? { warnings: skippedVisionPages.length, degraded: true } : {}) };
    } catch (error) {
      if (error instanceof UnsupportedMimeError) throw new UnsupportedSourceError("unsupported source MIME");
      if (error instanceof ConversionFailedError) throw new Error(`document conversion failed: ${error.message}`);
      throw error;
    } finally {
      try { await execution?.stop(); }
      finally { await rm(workDir, { recursive: true, force: true }); }
    }
  };
}
