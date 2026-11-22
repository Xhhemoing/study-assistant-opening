import type { Scope, SourceChunk } from "@aistudy/contracts";
import { knowledgeDefinitionHeader, knowledgeNodeDefinition, serializeKnowledgeEvidence } from "@aistudy/domain";
import type { PendingQuery, Row, Sql, TransactionSql } from "postgres";
import { storedKnowledgeSnapshotSchema } from "./opening-knowledge-snapshot";
import { pendingPdfFailureBoundaryPattern } from "./opening-pdf-segments";

const definitionPatchByteLimit = 256 * 1024;
const pdfHeadingContainer = String.raw`(?:(?:appendix(?: +[\w.]+)?|(?:chapter|section|lecture|lesson|module|part|unit) +[\w.]+|第 *[一二三四五六七八九十百千\d]+ *(?:章节|讲义|部分|单元|章|节|讲)|附录(?: *[A-Z0-9一二三四五六七八九十]+)?)(?: *[:：.\-—–] *| +)|附录)`;
const englishAnswerQualifier = String.raw`(?:model|selected|official|reference|correct|sample|odd-numbered|even-numbered)`;
const englishContinuation = String.raw`(?: *\( *(?:continued|cont(?:['’]?d)?\.?) *\))?`;
const chineseAnswerHeading = "(?:参考答案与解析|参考答案|标准答案|正确答案|课后习题答案|课后练习答案|课后练习解答|课后答案|课后解答|章节答案|习题答案|习题解答|练习题答案|练习题解答|练习答案|练习解答|复习题答案|复习题解答|自测题答案|自测题解答|思考题答案|部分习题答案|答案与解析|参考解答|详细解答)";
const chineseContinuation = String.raw`(?: *[（(](?:续|接上页)[）)])? *`;
const chineseExplanation = "(?:解答|解析|详解)";
const assessmentNumber = String.raw`#?\d+(?:\.\d+)*`;
const assessmentTarget = String.raw`(?: +${assessmentNumber}(?:(?: *[-–—] *| +(?:to|through) +)${assessmentNumber})?)?`;
const assessmentTopic = String.raw`(?:(?:review +questions?|practice +problems?|self[- ]check +exercises?|exercises?|problems?|questions?)${assessmentTarget}|chapter +\d+|section +\d+(?:\.\d+)*)`;
const assessmentQualifier = String.raw`(?:(?:the|selected|odd-numbered|even-numbered|all|chapter +\d+|section +\d+(?:\.\d+)*) +)*`;
const assessmentAnswers = String.raw`(?:answers?|solutions?|key) +to +${assessmentQualifier}${assessmentTopic}`;
const qualifiedSectionAnswers = String.raw`(?:(?:selected|odd-numbered|even-numbered) +answers?|model +answers|(?:official|reference) +solutions|solutions? +manual|answers? +and +solutions?)`;
const lineStart = String.raw`^ *(?:#{1,6} +)*`;
// Standalone answer keys and bare "Answers" open a section. Numbered inline labels
// and a singular "Answer:" affect the current chunk alone.
const sectionAnswer = String.raw`(?:(?:${pdfHeadingContainer})?(?:(?:${assessmentAnswers}|${qualifiedSectionAnswers})${englishContinuation} *(?:[:：]|$)|(?:answers? +(?:key|section)|answers)${englishContinuation} *[:：]? *$|(?:【 *${chineseAnswerHeading}${chineseContinuation}】|${chineseAnswerHeading}${chineseContinuation} *(?:[:：]|$))|答案${chineseContinuation}[:：]? *$)|${pdfHeadingContainer}(?:answers? +key|(?:${englishAnswerQualifier} +)?(?:answers?|solutions?)|${chineseAnswerHeading}|答案|解答)${englishContinuation} *(?:[:：]|$))`;
const inlineAnswer = String.raw`(?:(?:answers? +(?:key|section)|${englishAnswerQualifier} +answers?|(?:official|reference) +solutions?|answers?)${englishContinuation} *(?:[:：]|$)|(?:【 *)?(?:${chineseAnswerHeading}|答案)${chineseContinuation}(?:】|[:：]|$))`;
const numberedAnswer = String.raw`(?:(?:(?:${englishAnswerQualifier}|worked|full) +)?(?:answers?(?: +key)?|solutions?)|key)(?: +to +(?:exercise|problem|question))? *\d+(?:\.\d+)*${englishContinuation} *(?:[:：]|[.。](?: |$)|$)|(?:${chineseAnswerHeading}|答案) *\d+(?:[.-]\d+)*${chineseContinuation}(?:[:：、】]|[.。](?: |$)|$)`;
const sectionAnswerLine = String.raw`${lineStart}(?:${sectionAnswer}|解答${chineseContinuation}[:：]? *$)`;
const answerLabelLine = String.raw`${lineStart}(?:${sectionAnswer}|(?:${pdfHeadingContainer})?(?:${inlineAnswer}|${numberedAnswer}))`;
const explanationLabelLine = String.raw`${lineStart}(?:${pdfHeadingContainer})?(?:【 *${chineseExplanation}${chineseContinuation}】|${chineseExplanation}${chineseContinuation}(?=[:：]|$)|(?:${chineseExplanation}|解) *(?:\d+(?:[.-]\d+)*)?${chineseContinuation}[:：]|(?:${chineseExplanation}|解) *\d+(?:[.-]\d+)*${chineseContinuation}(?:[、】]|[.。](?: |$)|$))`;
const answerLabel = new RegExp(answerLabelLine, "imu");
const explanationLabel = new RegExp(explanationLabelLine, "iu");
const horizontalWhitespace = "[ \t\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+";
const pdfHorizontalWhitespace = new RegExp(horizontalWhitespace, "gu");
const closingAtxHashes = String.raw`^( *#{1,6}(?: +.*?)?) +#+ *$`;
const pdfClosingAtxHashes = new RegExp(closingAtxHashes, "gmu");

// Reopen at the first content line, so earlier answer text on a physical page
// cannot become public because a later line happens to look like a heading.
const markdownTitle = String.raw`#{1,6} +(?!(?:chapter|section|part|unit|lecture|lesson|module|appendix)(?: |$)|第 *[一二三四五六七八九十百千\d]+|附录)(?:\d+(?:\.\d+)+ +)?[[:alpha:]一-龥]`;
const backMatterHeading = String.raw`(?:preface|introduction|bibliography|references|works +cited|index|subject +index|author +index|glossary|notation +index|acknowledg(?:e)?ments?|about +the +authors?|afterword|colophon|序言|前言|引言|参考文献|索引|名词索引|主题索引|符号表|词汇表|后记|致谢) *(?:[:：.—–-]|$)`;
const backMatterLine = lineStart + backMatterHeading;
const blockedReopeningHeading = [
  String.raw`${lineStart}(?:(?:(?:scanned|physical|printed|pdf) +)*(?:pages?|slides?)|(?:(?:cached|raw|readable|verified|automatic) +)*(?:transcription|ocr)|[ivxlcdm]+[.。]? *$)(?:[ :：]|$)`,
  String.raw`${lineStart}(?:(?:\d+|[a-z])[.)](?: |$)|[a-z] *$|[（(] *(?:\d+|[a-z]|[一二三四五六七八九十]+) *[)）])`,
  String.raw`${lineStart}(?:\d+(?:\.\d+)*[.)]? +)?(?:true|false|yes|no|none|[a-f](?: *, *[a-f])*)[.。]? *$`,
  String.raw`\m(?:answers?|solutions?|keys?|exercises?|problems?|questions?|review|practice|quiz|drills?|self[- ]check|homework|assignments?|problem +sets?|worksheets?|tutorials?|recitations?|labs?|continued|cont(?:['’]?d)?)\M`,
  String.raw`(?:pages?|slides?|pp?\.) *\d+ *(?:(?:of +|[/／–-] *)\d+ *)?[)）\]]? *[.。]?$|(?:第 *)?[\d一二三四五六七八九十百千]+(?: *(?:[/／–-]|共) *(?:第 *)?[\d一二三四五六七八九十百千]+)? *[页頁]`,
  String.raw`答案|解答|习题|练习|复习题|自测题|思考题|作业|课后题|单元测试|第 *[一二三四五六七八九十百千\d]+ *[题小题]|续上页|接上页|[（(] *续 *[）)]`,
].join("|");

// Only extraction and transcription headers may precede a reopening heading.
const pdfLeadingTextWrappers = String.raw`^(?: *(?:\[(?:原生提取|本地提取（可能含OCR）|视觉转写与描述)\]|【原图忠实转写，尚需核对】) *(?:\n[ \n]*|$))+`;
const exerciseHeading = String.raw`${lineStart}(?:(?:exercises?|practice +problems?|(?:problem|question) +\d+)\M|习题|练习题?|思考题|作业题)`;
const qualifiedExerciseAnswer = String.raw`(?:参考答案|标准答案|正确答案|参考解答|详细解答)${chineseContinuation}[:：] *(?=[^ ])`;
const bracketedExerciseAnswer = String.raw`【 *正确答案 *】 *$`;
const exerciseSectionException = String.raw`${lineStart}(?:${bracketedExerciseAnswer}|答案 *[:：] *$|解答${chineseContinuation}[:：]? *$|${qualifiedExerciseAnswer})`;
const exerciseInlineAnswer = String.raw`${lineStart}(?:${bracketedExerciseAnswer}|【 *(?:答案|${chineseExplanation})${chineseContinuation}】 *[:：]? *|(?:答案|解|${chineseExplanation}) *(?:\d+(?:[.-]\d+)*)?${chineseContinuation}[:：] *|${chineseExplanation}${chineseContinuation}$|${qualifiedExerciseAnswer}|(?:(?:${englishAnswerQualifier} +)?answer(?: +key)?|(?:(?:worked|full|sample|official|reference) +)?solution)(?: +\d+(?:\.\d+)*)?${englishContinuation} *(?:[:：] *|$))`;

const workedExampleHeading = String.raw`${lineStart}(?:${pdfHeadingContainer})?(?:(?:worked +example|example)(?= +\d| *[(:：.．—–-]| *$)|例题(?= *\d| *[（(:：.．—–-]| *$)|例 *(?=\d|[:：]))`;
const englishBlock = String.raw`(?:definition|notation|terminology|convention|theorem|lemma|proposition|corollary|axiom|conjecture|claim|proof(?: +of +(?:theorem|lemma|proposition|corollary))?)`;
const captionName = String.raw`(?:figure|fig\.?|table|tab\.?|chart|diagram|scheme|algorithm|listing)`;
const captionPrefix = String.raw`${lineStart}${captionName}(?= |[:：]|$)`;
const headingId = String.raw`(?:(?:[a-z][.-]?)?\d+(?:[.-]\d+)*|[ivxlcdm]+)(?=[ :：.．—–(-]|$)`;
const numberedBlockPrefix = String.raw`${lineStart}(?:${englishBlock}|${captionName}) +${headingId}`;
const englishContainerPrefix = String.raw`${lineStart}(?:(?:chapter|section|part|unit|lecture|lesson|module) +(?:\d+(?:\.\d+)*|[ivxlcdm]+)|appendix(?: +(?:[a-z](?![a-z\d])|\d+))?)(?=[ :：.．—–(-]|$)`;
const chineseContainerPrefix = String.raw`${lineStart}(?:第 *[一二三四五六七八九十百千\d]+ *(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课])|附录(?: *(?:[A-Z](?![a-z])|[0-9一二三四五六七八九十]+))?)`;
const chineseBlocks = "(?:定义|记号|术语|约定|定理|引理|推论|命题|公理|猜想|证明)";
const chineseNumberedBlock = String.raw`${lineStart}(?:${chineseBlocks}|图|表|插图|附表|算法) *\d+(?:[.-]\d+)*`;
const chineseHeadingDelimiter = String.raw`^ *(?:[:：.．、—–(（-]|$)`;
const chineseReferenceProse = String.raw`[。！？；] *$|^ *(?:给出|显示|展示|表明|说明|证明|解释|指出|列出|描述|表示|讨论|介绍|包含|汇总|满足|成立|可由|由|中|里|内|上|下|的|是|为|有|在|与|和|将|把|对|见|如)`;
const englishContainerSuffix = String.raw`^(?: *(?:[:：．—–(]|\.(?!\d)|-(?!\d)|$)| +[A-Z0-9一-龥])`;
const appendixHeading = String.raw`${lineStart}(?:appendix(?= |[:：]|$)|附录)`;
const bareContainerSuffix = String.raw`^[ :：.．—–-]*$`;
const inlinePublicHeading = String.raw`${lineStart}(?:${englishBlock} *(?:[:：．—–(]|\.(?!\d)|-(?!\d)|$)|${chineseBlocks} *(?:[:：]|$)|\d+(?:\.\d+)+ +[^ ])`;
const explicitHeadingMarkup = String.raw`^ *#{1,6} +[^ ]`;

const jsWorkedExample = new RegExp(workedExampleHeading, "iu");
const jsNumberedBlock = new RegExp(numberedBlockPrefix, "iu");
const jsChineseNumberedBlock = new RegExp(chineseNumberedBlock, "u");
const jsEnglishContainer = new RegExp(englishContainerPrefix, "iu");
const jsChineseContainer = new RegExp(chineseContainerPrefix, "u");
const jsChineseDelimiter = new RegExp(chineseHeadingDelimiter, "u");
const jsChineseProse = new RegExp(chineseReferenceProse, "u");
const jsEnglishContainerSuffix = new RegExp(englishContainerSuffix, "u");
const jsPublicHeading = new RegExp(inlinePublicHeading, "iu");
const jsCaptionPrefix = new RegExp(captionPrefix, "iu");
const jsMarkdownTitle = new RegExp(("^ *" + markdownTitle).replaceAll("[[:alpha:]一-龥]", "[\\p{L}]"), "iu");
const jsBackMatter = new RegExp(backMatterLine, "iu");
const jsBlockedReopening = new RegExp(blockedReopeningHeading.replaceAll(String.raw`\m`, String.raw`\b`).replaceAll(String.raw`\M`, String.raw`\b`), "iu");
const jsExerciseHeading = new RegExp(exerciseHeading.replace(String.raw`\M`, String.raw`\b`), "iu");
const jsExplicitHeading = new RegExp(explicitHeadingMarkup, "u");

export function containsPdfAnswerLabel(text: string, { checkContext = true } = {}): boolean {
  const normalized = text.replace(/\r/gu, "").replace(pdfHorizontalWhitespace, " ").replace(pdfClosingAtxHashes, "$1");
  if (answerLabel.test(normalized.replace(/\*\*|__/gu, ""))) return true;
  if (!checkContext) return false;
  let inWorkedExample = false;
  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.replace(/\*\*|__/gu, "");
    if (explanationLabel.test(line)) {
      if (!inWorkedExample) return true;
      continue;
    }
    if (jsWorkedExample.test(line)) {
      inWorkedExample = true;
    } else if (inWorkedExample) {
      const numbered = jsNumberedBlock.exec(line);
      const chinese = jsChineseNumberedBlock.exec(line) ?? jsChineseContainer.exec(line);
      const container = jsEnglishContainer.exec(line);
      const atx = jsExplicitHeading.test(rawLine);
      const chineseSuffix = chinese ? line.slice(chinese[0].length) : "";
      if (jsExerciseHeading.test(line) || jsPublicHeading.test(line)
        || (numbered && (atx || !/^ +[a-z]/u.test(line.slice(numbered[0].length))))
        || (chinese && (atx || jsChineseDelimiter.test(chineseSuffix) || !jsChineseProse.test(chineseSuffix)))
        || ((container && (atx || jsEnglishContainerSuffix.test(line.slice(container[0].length))))
          || jsBackMatter.test(line) || (atx && !jsCaptionPrefix.test(line) && jsMarkdownTitle.test(line)))
          && !jsBlockedReopening.test(line)) {
        inWorkedExample = false;
      }
    }
  }
  return false;
}

const pageNumberRatio = String.raw`\d+ *(?:of +|[/／–—-] *)\d+`;
const chinesePageNumber = String.raw`[\d一二三四五六七八九十百千零〇]+`;
const chinesePage = String.raw`(?:第 *)?${chinesePageNumber} *[页頁]`;
const chinesePageTotal = String.raw`共 *${chinesePageNumber} *[页頁]`;
const chineseCounter = String.raw`(?:${chinesePage}(?: *[（(] *${chinesePageTotal} *[）)]| *[/／,，] *${chinesePageTotal})?|${chinesePageTotal} +${chinesePage}|(?:第 *)?${chinesePageNumber} *(?:[/／–—-]|共) *${chinesePage})`;
const counter = String.raw`(?:\d+(?:\.\d+)*|[ivxlcdm]+)`;
const inlineRunningHeading = String.raw`${lineStart}(?:\d+(?:\.\d+)*|[ivxlcdm]+ *[.。．、]?|[(（\[【] *${counter} *[)）\]】] *[.。．、]?|[-–—] *${counter} *[-–—] *[.。．、]?|${pageNumberRatio} *[)）\]】]? *[.。．、]?|[(（\[【]? *(?:(?:(?:scanned|physical|printed|pdf) +)*(?:pages?|slides?) +|pp?\. *)\d+(?: *(?:of +|[/／–—-] *)\d+)? *[)）\]】]? *[.。]?|${chineseCounter} *[.。．、]?) *$`;
const inlineTerminal = String.raw`[.。!?！？;；)）\]】□■∎] *$`;
const inlineContinues = String.raw`(?:\( *(?:to +be +continued|continued(?: +on +next +page)?) *\)|[（(] *(?:下接下页|转下页|未完待续) *[）)]|接下页|转下页) *$`;
const inlineTerminator = String.raw`(?:[□■∎]|end +of +answers?|答案完|解答完) *[.。]? *$`;

/** Legacy markers predate the explicit publication receipt. New markers are
 * settled only by the chunk transaction, even if a retry updates source status. */
function pendingPdfSeal(sql: Sql, source: "s" | "ps") {
  const state = source === "s" ? sql`s.parse_state<>'ready' OR seal.updated_at>s.updated_at`
    : sql`ps.parse_state<>'ready' OR seal.updated_at>ps.updated_at`;
  const historical = source === "s" ? sql`seal.source_version<s.version` : sql`seal.source_version<ps.version`;
  return sql`CASE seal.pages->0->>'publicationSealCommitted'
    WHEN 'true' THEN FALSE WHEN 'false' THEN TRUE
    ELSE (NOT (${historical}) AND (${state})) END`;
}

export function publicPdfSealBoundaries(sql: Sql, workspaceId: string,
  scope: { sourceIds: readonly string[] } | { chunkId: string }) {
  const requestedSources = "sourceIds" in scope ? sql`s.id=ANY(${scope.sourceIds}::uuid[])`
    : sql`s.id=(SELECT source_id FROM opening_source_chunks WHERE id=${scope.chunkId})`;
  // Every newer tightening invalidates stale downstream chunks until replacement.
  // A verified reopening and all settled markers commit with that replacement.
  return sql`WITH pdf_read_sources AS MATERIALIZED (
    SELECT s.id,s.workspace_id,s.version,s.parse_state,s.updated_at
    FROM opening_sources s WHERE s.workspace_id=${workspaceId} AND s.mime='application/pdf' AND ${requestedSources}
  ), pdf_pending_seals AS MATERIALIZED (
    SELECT seal.source_id,seal.source_version,min(CASE WHEN seal.parser_profile='pdf-publication-page-seal-v1'
      THEN seal.page_start ELSE substring(seal.parser_profile FROM ${pendingPdfFailureBoundaryPattern})::int END) AS first_page
    FROM opening_pdf_parse_segments seal
    JOIN pdf_read_sources ps ON ps.id=seal.source_id AND ps.workspace_id=seal.workspace_id
    WHERE seal.workspace_id=${workspaceId}
      AND ((seal.parser_profile='pdf-publication-page-seal-v1' AND seal.state='ready' AND seal.page_end=seal.page_start
        AND (seal.pages->0->>'sectionSealedAtEnd'='true' OR seal.pages->0->>'inlineSealedAtEnd'='true'
          OR seal.pages->0->>'publicationSealUnknown'='true')
        AND (${pendingPdfSeal(sql, "ps")}))
        OR seal.parser_profile ~ ${pendingPdfFailureBoundaryPattern})
    GROUP BY seal.source_id,seal.source_version
  )${"sourceIds" in scope ? sql`, ${archivedPdfSealSpans(sql, sql`c.source_id=ANY(ARRAY(SELECT id FROM pdf_read_sources))`)}` : sql``}`;
}

function archivedPdfSealSpans(sql: Sql, scope: PendingQuery<Row[]>) {
  return sql`pdf_archive_text AS (
    SELECT c.id,c.source_id,c.source_version,c.page,c.created_at,
      string_to_array(regexp_replace(
        regexp_replace(replace(c.text,chr(13),''),${horizontalWhitespace},' ','g'),
        ${"(?n)" + closingAtxHashes},${String.raw`\1`},'g'),chr(10)) AS lines
    FROM opening_source_chunks c
    WHERE ${scope} AND c.page IS NOT NULL
  ), pdf_archive_headings AS (
    SELECT *,
      (english_container IS NOT NULL AND (atx OR english_container ~ ${englishContainerSuffix})
        OR chinese_container IS NOT NULL AND (atx OR chinese_container ~ ${chineseHeadingDelimiter}
          OR chinese_container !~ ${chineseReferenceProse})) AND line !~* ${blockedReopeningHeading} AS public_container,
      (english_numbered IS NOT NULL AND (atx OR english_numbered !~ '^ +[a-z]')
        OR chinese_numbered IS NOT NULL AND (atx OR chinese_numbered ~ ${chineseHeadingDelimiter}
          OR chinese_numbered !~ ${chineseReferenceProse})) AS public_numbered,
      (line ~* ${backMatterLine} OR (atx AND line ~* ${"^ *" + markdownTitle}
        AND (line !~* ${captionPrefix} OR english_numbered IS NOT NULL)))
        AND line !~* ${blockedReopeningHeading} AS other_reopening
    FROM (
      SELECT *, raw_line ~ ${explicitHeadingMarkup} AS atx,
        NULLIF(regexp_replace(line,${englishContainerPrefix},'','i'),line) AS english_container,
        NULLIF(regexp_replace(line,${chineseContainerPrefix},''),line) AS chinese_container,
        NULLIF(regexp_replace(line,${numberedBlockPrefix},'','i'),line) AS english_numbered,
        NULLIF(regexp_replace(line,${chineseNumberedBlock},''),line) AS chinese_numbered
      FROM (
        SELECT *,replace(replace(raw_line,'**',''),'__','') AS line
        FROM (
          SELECT id,source_id,source_version,page,created_at,unnest(lines) AS raw_line,
            generate_subscripts(lines,1) AS line_number
          FROM pdf_archive_text
        ) raw_lines
      ) normalized_lines
    ) heading_suffixes
  ), pdf_archive_lines AS (
    SELECT id,source_id,source_version,page,line,
      row_number() OVER (PARTITION BY source_id,source_version ORDER BY page,created_at,id,line_number) AS position,
      line ~* ${exerciseHeading} AS opens_exercise,
      line ~* ${workedExampleHeading} AS opens_worked_example,
      (line ~* ${inlinePublicHeading} OR line ~* ${workedExampleHeading}
        OR public_numbered OR public_container OR other_reopening)
        AND line !~* ${answerLabelLine} AND line !~* ${explanationLabelLine} AS opens_public,
      (other_reopening OR public_container AND (line ~* ${appendixHeading}
        OR COALESCE(english_container,chinese_container) !~ ${bareContainerSuffix})) AS reopens_section,
      line ~* ${sectionAnswerLine} AS opens_section,
      line ~* ${answerLabelLine} AS unconditional_answer,
      line ~* ${explanationLabelLine} AS explanation_label,
      line ~* ${exerciseSectionException} AS exercise_exception,
      line ~* ${pdfLeadingTextWrappers} AS wrapper
    FROM pdf_archive_headings
  ), pdf_archive_exercise_context AS (
    SELECT *, COALESCE(max(position) FILTER (WHERE opens_exercise) OVER context,0)
      > COALESCE(max(position) FILTER (WHERE (opens_section AND NOT exercise_exception)
        OR (opens_public AND NOT opens_exercise)) OVER context,0) AS in_exercise,
      COALESCE(max(position) FILTER (WHERE opens_worked_example) OVER context,0)
      > COALESCE(max(position) FILTER (WHERE unconditional_answer OR opens_exercise
        OR (opens_public AND NOT opens_worked_example)) OVER context,0) AS in_worked_example
    FROM pdf_archive_lines
    WINDOW context AS (PARTITION BY source_id,source_version ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
  ), pdf_archive_line_events AS (
    SELECT *, opens_section AND NOT (in_exercise AND exercise_exception)
      AND NOT (in_worked_example AND explanation_label) AS section_answer,
      explanation_label AND NOT in_worked_example AS sealed_explanation,
      in_exercise AND line ~* ${exerciseInlineAnswer}
        AND (NOT opens_section OR exercise_exception) AND NOT (in_worked_example AND explanation_label) AS inline_opener
    FROM pdf_archive_exercise_context
  ), pdf_archive_page_events AS (
    SELECT source_id,source_version,page,bool_or(section_answer) AS section_answer,
      bool_or(inline_opener OR unconditional_answer OR sealed_explanation) AS answer_label,
      (array_agg(reopens_section ORDER BY position) FILTER (WHERE NOT wrapper AND btrim(line)<>''))[1] AS reopens_section
    FROM pdf_archive_line_events
    GROUP BY source_id,source_version,page
  ), pdf_archive_inline_groups AS (
    -- An opener and its continuation lines share a group until the next explicit boundary.
    SELECT *, count(*) FILTER (WHERE inline_opener OR section_answer OR opens_exercise OR opens_public)
      OVER (PARTITION BY source_id,source_version ORDER BY position ROWS UNBOUNDED PRECEDING) AS inline_group,
      CASE WHEN inline_opener THEN btrim(regexp_replace(line,${exerciseInlineAnswer},'','i'))
        WHEN wrapper OR line ~* ${inlineRunningHeading} THEN '' ELSE btrim(line) END AS body_line
    FROM pdf_archive_line_events
  ), pdf_archive_inline_body AS (
    SELECT *, min(position) FILTER (WHERE body_line<>'')
      OVER (PARTITION BY source_id,source_version,inline_group,page) AS first_body
    FROM pdf_archive_inline_groups
  ), pdf_archive_inline_pages AS (
    SELECT source_id,source_version,inline_group,page,bool_or(inline_opener) AS starts_inline,
      bool_or(inline_opener AND NOT (unconditional_answer OR sealed_explanation)) AS hide_opening_page,
      (array_agg(body_line ORDER BY position DESC) FILTER (WHERE body_line<>''))[1] AS last_body,
      min(position) FILTER (WHERE btrim(line)='' AND position>first_body)
        < max(position) FILTER (WHERE body_line<>'') AS closed_after_blank,
      bool_or(body_line ~* ${inlineTerminator}) AS ended_inline
    FROM pdf_archive_inline_body
    GROUP BY source_id,source_version,inline_group,page
  ), pdf_archive_inline_spans AS (
    -- A finished answer affects later pages only up to its first closing page.
    SELECT source_id,source_version,min(page) FILTER (WHERE starts_inline) AS first_page,
      bool_or(hide_opening_page) AS hide_opening_page,
      COALESCE(min(page) FILTER (WHERE closed_after_blank OR ended_inline
        OR (last_body ~* ${inlineTerminal} AND last_body !~* ${inlineContinues})),max(page)) AS last_page
    FROM pdf_archive_inline_pages
    GROUP BY source_id,source_version,inline_group
    HAVING bool_or(starts_inline)
  ), pdf_archive_sealed_spans AS MATERIALIZED (
    SELECT source_id,source_version,first_page,reopen_page,NULL::uuid AS chunk_id FROM (
      SELECT source_id,source_version,page AS first_page,section_answer,
        lead(page) OVER (PARTITION BY source_id,source_version ORDER BY page) AS reopen_page
      FROM pdf_archive_page_events
      WHERE section_answer OR (NOT answer_label AND reopens_section)
    ) events WHERE section_answer
    UNION ALL
    SELECT source_id,source_version,first_page,last_page+1,NULL::uuid
    FROM pdf_archive_inline_spans WHERE first_page<last_page OR hide_opening_page
    UNION ALL
    SELECT DISTINCT source_id,source_version,page,page+1,id
    FROM pdf_archive_line_events WHERE sealed_explanation
  )`;
}

/** Chunk and source aliases are c and s at each publication read. */
export function publicPdfChunkPredicate(sql: Sql, { checkArchive = true } = {}) {
  return sql`(s.mime<>'application/pdf' OR c.page IS NULL OR (
    NOT EXISTS (
      SELECT 1 FROM pdf_pending_seals boundary
      WHERE boundary.source_id=c.source_id AND boundary.source_version=c.source_version AND boundary.first_page<=c.page
    ) ${checkArchive ? sql`AND NOT EXISTS (
      SELECT 1 FROM pdf_archive_sealed_spans archived
      WHERE archived.source_id=c.source_id AND archived.source_version=c.source_version
        AND archived.first_page<=c.page AND (archived.reopen_page IS NULL OR c.page<archived.reopen_page)
        AND (archived.chunk_id IS NULL OR archived.chunk_id=c.id)
    )` : sql``} AND NOT EXISTS (
      SELECT 1 FROM opening_pdf_parse_segments seal
      WHERE seal.workspace_id=s.workspace_id AND seal.source_id=c.source_id AND seal.source_version=c.source_version
        AND seal.parser_profile='pdf-publication-page-seal-v1' AND seal.state='ready'
        AND seal.page_start=c.page AND seal.page_end=c.page
        AND (seal.pages->0->>'hadSealedContent'='true' OR seal.pages->0->>'inlineSealedAtEnd'='true'
          OR seal.pages->0->>'sectionSealedAtEnd'='true' OR seal.pages->0->>'publicationSealUnknown'='true')
        AND (c.image_object_key IS NOT NULL OR (${pendingPdfSeal(sql, "s")}))
    )
  ))`;
}

export function isPublicSourceChunk(row: Record<string, unknown>): boolean {
  // The archive scans physical pages in order. Page-less chunks have only local context.
  return row.mime !== "application/pdf" || !containsPdfAnswerLabel(row.text as string, { checkContext: row.page == null });
}

type ArchivedSealSpan = { first_page: number; reopen_page: number | null; chunk_id: string | null };

async function readCitedChunk(tx: TransactionSql, scope: Scope, courseId: string, id: string,
  archivedSpans: Map<string, ArchivedSealSpan[]>) {
  // Read one text at a time. A single existing chunk can itself exceed 256 KiB in UTF-8.
  const [row] = await tx<Array<SourceChunk & { mime: string }>>`
    ${publicPdfSealBoundaries(tx, scope.workspaceId, { chunkId: id })}
    SELECT c.id,c.source_id AS "sourceId",c.source_version AS "sourceVersion",
    s.mime AS mime,
    c.page,c.slide_label AS "slideLabel",c.start_ms AS "startMs",c.end_ms AS "endMs",c.text,c.image_object_key AS "imageObjectKey"
    FROM opening_source_chunks c
    JOIN opening_sources s ON s.id=c.source_id AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
    JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id
      AND v.version=c.source_version AND v.availability='available'
    JOIN course_asset_memberships m ON m.workspace_id=s.workspace_id AND m.course_id=${courseId}
      AND m.asset_type='source' AND m.asset_id=s.id
    JOIN opening_course_knowledge graph ON graph.workspace_id=s.workspace_id AND graph.course_id=m.course_id
      AND graph.owner_user_id=${scope.ownerUserId}
    WHERE c.id=${id} AND c.source_version::text=graph.source_versions->>s.id::text
      AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
      AND ${publicPdfChunkPredicate(tx, { checkArchive: false })}
    FOR SHARE OF c,s,v,m`;
  if (row?.id !== id) return undefined;
  const { mime, ...chunk } = row;
  if (mime !== "application/pdf") return chunk;
  if (!isPublicSourceChunk(row)) return undefined;
  if (chunk.page == null) return chunk;

  // The source share lock from the citation read lasts through backfill, blocking
  // chunk replacements. Reuse only page boundaries, keeping cited texts streamed.
  const key = `${chunk.sourceId}:${chunk.sourceVersion}`;
  let spans = archivedSpans.get(key);
  if (!spans) {
    const version = tx`c.source_id=${chunk.sourceId} AND c.source_version=${chunk.sourceVersion}`;
    spans = await tx<ArchivedSealSpan[]>`WITH ${archivedPdfSealSpans(tx, version)}
      SELECT first_page,reopen_page,chunk_id FROM pdf_archive_sealed_spans`;
    archivedSpans.set(key, spans);
  }
  const page = chunk.page;
  return spans.some(span => (span.chunk_id == null || span.chunk_id === id)
    && span.first_page <= page && (span.reopen_page == null || page < span.reopen_page))
    ? undefined : chunk;
}

/** Upgrade pre-definition graphs before the parser replaces their evidence UUIDs.
 * Workspace → graph → source/chunks matches graph publication and privacy writes. */
export async function preserveOpeningKnowledgeDefinitions(tx: TransactionSql, scope: Scope, sourceId: string, sourceVersion: number): Promise<void> {
  const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!owner) throw new Error("workspace not found");
  const graphs = await tx<{ course_id: string; node_indexes: number[] }[]>`SELECT graph.course_id, missing.node_indexes
    FROM opening_course_knowledge graph
    CROSS JOIN LATERAL (
      SELECT array_agg((node.position - 1)::int ORDER BY node.position) AS node_indexes
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(graph.snapshot->'nodes')='array'
        THEN graph.snapshot->'nodes' ELSE '[]'::jsonb END) WITH ORDINALITY AS node(value,position)
      WHERE COALESCE(graph.node_definitions->(node.value->>'id'), 'null'::jsonb)
        IN ('null'::jsonb, '""'::jsonb, 'false'::jsonb, '0'::jsonb)
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(node.value->'evidenceChunkIds')='array'
            THEN node.value->'evidenceChunkIds' ELSE '[]'::jsonb END) AS cited(id)
          JOIN opening_source_chunks c ON c.id=CASE WHEN pg_input_is_valid(cited.id, 'uuid') THEN cited.id::uuid END
          WHERE c.source_id=${sourceId} AND c.source_version=${sourceVersion}
        )
    ) missing
    WHERE graph.workspace_id=${scope.workspaceId} AND graph.owner_user_id=${scope.ownerUserId}
      AND graph.source_versions->>${sourceId}=${String(sourceVersion)} AND missing.node_indexes IS NOT NULL
    ORDER BY graph.course_id FOR UPDATE OF graph`;
  let evidenceStageReady = false;
  const archivedSpans = new Map<string, ArchivedSealSpan[]>();
  for (const { course_id: courseId, node_indexes: nodeIndexes } of graphs) {
    const [graph] = await tx`SELECT snapshot FROM opening_course_knowledge
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
    const parsed = storedKnowledgeSnapshotSchema.safeParse(graph?.snapshot);
    if (!parsed.success || parsed.data.courseId !== courseId) continue;

    let patch: Record<string, string> = {};
    let patchCount = 0;
    let patchBytes = 0;
    const flush = async () => {
      if (!patchCount) return;
      await tx`UPDATE opening_course_knowledge SET node_definitions=node_definitions || ${tx.json(patch)}::jsonb
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
      patch = {};
      patchCount = 0;
      patchBytes = 0;
    };

    for (const index of nodeIndexes) {
      const node = parsed.data.nodes[index]!;
      const evidenceIds = new Set(node.evidenceChunkIds);
      if (evidenceIds.size === 1) {
        const chunk = await readCitedChunk(tx, scope, courseId, node.evidenceChunkIds[0]!, archivedSpans);
        const definition = chunk && knowledgeNodeDefinition(node, [chunk]);
        if (!definition) continue;
        const bytes = Buffer.byteLength(JSON.stringify(definition)) + node.id.length + 4;
        if (patchCount === 16 || patchBytes + bytes > definitionPatchByteLimit) await flush();
        patch[node.id] = definition;
        patchCount++;
        patchBytes += bytes;
        continue;
      }

      // A single definition can cite every page. Keep its serialized evidence in
      // PostgreSQL, using UTF-16 sort keys to match JavaScript's exact definition format.
      await flush();
      if (!evidenceStageReady) {
        await tx`CREATE TEMP TABLE opening_legacy_knowledge_evidence (content text, sort_key bytea) ON COMMIT DROP`;
        evidenceStageReady = true;
      }
      let complete = true;
      for (const id of evidenceIds) {
        const chunk = await readCitedChunk(tx, scope, courseId, id, archivedSpans);
        const content = chunk && serializeKnowledgeEvidence(chunk);
        if (!content) { complete = false; break; }
        const sortKey = Buffer.from(content, "utf16le").swap16();
        await tx`INSERT INTO pg_temp.opening_legacy_knowledge_evidence (content,sort_key) VALUES (${content},${sortKey})`;
      }
      if (complete) {
        const header = JSON.stringify(knowledgeDefinitionHeader(node)).slice(0, -1);
        await tx`UPDATE opening_course_knowledge SET node_definitions=node_definitions || jsonb_build_object(
            ${node.id}::text, ${header}::text || ',[' || (
              SELECT string_agg(to_json(content)::text, ',' ORDER BY sort_key)
              FROM (SELECT DISTINCT ON (sort_key) content,sort_key FROM pg_temp.opening_legacy_knowledge_evidence
                ORDER BY sort_key) evidence
            ) || ']]')
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
      }
      await tx`TRUNCATE pg_temp.opening_legacy_knowledge_evidence`;
    }
    await flush();
  }
}
