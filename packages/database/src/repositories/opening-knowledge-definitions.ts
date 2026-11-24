import type { Scope, SourceChunk } from "@aistudy/contracts";
import { knowledgeDefinitionHeader, knowledgeNodeDefinition, serializeKnowledgeEvidence } from "@aistudy/domain";
import type { PendingQuery, Row, Sql, TransactionSql } from "postgres";
import { storedKnowledgeSnapshotSchema } from "./opening-knowledge-snapshot";
import { pendingPdfFailureBoundaryPattern } from "./opening-pdf-segments";

const definitionPatchByteLimit = 256 * 1024;
const pdfHeadingContainer = String.raw`(?:(?:appendix(?: +[\w.]+)?|(?:chapter|section|lecture|lesson|module|part|unit) +[\w.]+|第 *[一二三四五六七八九十百千\d]+ *(?:章节|讲义|部分|单元|章|节|讲)|附录(?: *[A-Z0-9一二三四五六七八九十]+)?)(?: *[:：.\-—–] *| +)|附录)`;
const englishAnswerQualifier = String.raw`(?:model|selected|official|reference|correct|sample|odd-numbered|even-numbered)`;
const solutionQualifier = "(?:official|reference|model|selected|correct|odd-numbered|even-numbered)";
const qualifiedSolution = String.raw`${solutionQualifier} +solutions?`;
const englishContinuationWord = String.raw`(?:continued|cont(?:['’]?d)?\.?)`;
const englishContinuation = String.raw`(?: *\( *${englishContinuationWord} *\))?`;
const chineseAnswerHeading = "(?:参考答案与解析|参考答案|标准答案|正确答案|课后习题答案|课后练习答案|课后练习解答|课后答案|课后解答|章节答案|习题答案|习题解答|练习题答案|练习题解答|练习答案|练习解答|复习题答案|复习题解答|自测题答案|自测题解答|思考题答案|部分习题答案|答案与解析|参考解答|详细解答)";
const chineseContinuation = String.raw`(?: *[（(](?:续|接上页)[）)])? *`;
const chineseExplanation = "(?:解答|解析|详解)";
const assessmentNumber = String.raw`#?\d+(?:\.\d+)*`;
const assessmentTarget = String.raw`(?: +${assessmentNumber}(?:(?: *[-–—] *| +(?:to|through) +)${assessmentNumber})?)?`;
const assessmentTopic = String.raw`(?:(?:review +questions?|practice +problems?|self[- ]check +exercises?|exercises?|problems?|questions?)${assessmentTarget}|chapter +\d+|section +\d+(?:\.\d+)*)`;
const assessmentQualifier = String.raw`(?:(?:the|selected|odd-numbered|even-numbered|all|chapter +\d+|section +\d+(?:\.\d+)*) +)*`;
const assessmentAnswers = String.raw`(?:answers?|solutions?|key) +to +${assessmentQualifier}${assessmentTopic}`;
const qualifiedSectionAnswers = String.raw`(?:(?:selected|odd-numbered|even-numbered) +answers?|model +answers|${solutionQualifier} +solutions|solutions? +manual|answers? +and +solutions?)`;
const lineStart = String.raw`^ *(?:#{1,6} +)*`;
const assessmentSolutionsHeading = String.raw`${lineStart}Solutions${englishContinuation} *[:：]? *$`;
const assessmentSolutionsContext = String.raw`${lineStart}(?:(?:Chapter|Section|Part|Unit|Lecture) +(?:\d+(?:\.\d+)*|[ivxlcdm]+)(?=[ :：.—–-]|$)|(?:Exercises?|Problems?|Questions?|Review(?: +Questions?)?|Practice(?: +Problems?)?|Quiz|Drills?|Self[- ]Check)\M(?= *(?:[:：.—–-]|$)| +(?:#?\d|(?:for|of|on|from) +(?:Chapter|Section|Part|Unit)\M))|(?:\d+|[a-z])[.)](?= |$)|[（(] *(?:\d+|[a-z]) *[)）](?= |$))`;
const standaloneAssessmentItem = String.raw`${lineStart}\d+[.)] *$`;
// Periods also end prose. Keep these patterns separate from case-insensitive answer labels.
const inlinePeriodSuffix = String.raw`(?: +\d+(?:\.\d+)*)?(?: *\( *(?:continued|cont\.?|CONTD?\.?|CONTINUED) *\))? *\.(?= |$)`;
const inlineAnswerPeriod = String.raw`(?:Answer +[Kk]ey|ANSWER +KEY|Answers?|ANSWERS?|(?:Official|Model|Correct|Sample|Reference) +[Aa]nswer|(?:OFFICIAL|MODEL|CORRECT|SAMPLE|REFERENCE) +ANSWER)${inlinePeriodSuffix}`;
const inlineSolutionPeriod = String.raw`(?:(?:Worked|Full|Sample|Official|Reference) +[Ss]olutions?|(?:WORKED|FULL|SAMPLE|OFFICIAL|REFERENCE) +SOLUTIONS?|Solutions?|SOLUTIONS?)(?: +(?:to|TO) +(?:Exercise|EXERCISE|Problem|PROBLEM|Question|QUESTION) *\d*(?:\.\d+)*)?${inlinePeriodSuffix}`;
const answerPeriodLine = String.raw`${lineStart}(?:${pdfHeadingContainer})?${inlineAnswerPeriod}`;
const solutionPeriodLine = String.raw`${lineStart}(?:${pdfHeadingContainer})?${inlineSolutionPeriod}`;
const exerciseInlineAnswerPeriod = String.raw`${lineStart}(?:${pdfHeadingContainer})?(?:${inlineAnswerPeriod}|${inlineSolutionPeriod})`;
// Standalone answer keys and bare "Answers" open a section. Singular "Answer:"
// and numbered labels can open an inline answer.
const sectionAnswer = String.raw`(?:(?:${pdfHeadingContainer})?(?:(?:${assessmentAnswers}|${qualifiedSectionAnswers})${englishContinuation} *(?:[:：]|$)|(?:answers? +(?:key|section)|answers)${englishContinuation} *[:：]? *$|(?:【 *${chineseAnswerHeading}${chineseContinuation}】|${chineseAnswerHeading}${chineseContinuation} *(?:[:：]|$))|答案${chineseContinuation}[:：]? *$)|${pdfHeadingContainer}(?:answers? +key|(?:${englishAnswerQualifier} +)?(?:answers?|solutions?)|${chineseAnswerHeading}|答案|解答)${englishContinuation} *(?:[:：]|$))`;
const inlineAnswer = String.raw`(?:(?:answers? +(?:key|section)|${englishAnswerQualifier} +answers?|(?:official|reference) +solutions?|answers?)${englishContinuation} *(?:[:：]|$)|(?:【 *)?(?:${chineseAnswerHeading}|答案)${chineseContinuation}(?:】|[:：]|$))`;
const numberedAnswerTarget = String.raw`(?: +to +(?:exercise|problem|question))`;
const numberedAnswerSuffix = String.raw` *\d+(?:\.\d+)*${englishContinuation} *(?:[:：]|[.。](?: |$)|$)`;
const qualifiedSolutionLabel = String.raw`${lineStart}${qualifiedSolution}(?:${numberedAnswerTarget}(?: *\d+(?:\.\d+)*)?)?(?: +\d+(?:\.\d+)*)?${englishContinuation} *(?:[:：] *|\.(?= |$) *|$)`;
const numberedAnswer = String.raw`(?:(?:(?:${englishAnswerQualifier}|worked|full) +)?answers?(?: +key)?|key|${qualifiedSolution})${numberedAnswerTarget}?${numberedAnswerSuffix}|(?:(?:worked|full|sample) +)?solutions?${numberedAnswerTarget}${numberedAnswerSuffix}|(?:${chineseAnswerHeading}|答案) *\d+(?:[.-]\d+)*${chineseContinuation}(?:[:：、】]|[.。](?: |$)|$)`;
// These labels can also explain a worked example. Qualified keys and explicit
// assessment targets remain unconditional answers.
const numberedSolution = String.raw`(?:(?:worked|full|sample) +)?solutions?${numberedAnswerSuffix}`;
const englishSolutionLabel = String.raw`solution${englishContinuation} *[:：]`;
const standaloneEnglishSolution = englishSolutionLabel + " *$";
const standaloneNumberedSolution = String.raw`${lineStart}(?:${standaloneEnglishSolution}|解答${chineseContinuation}[:：] *$)`;
const numberedQuestion = String.raw`${lineStart}\d+[.)] +[^ ]`;
const numberedExerciseInstruction = String.raw`${lineStart}\d+[.)] +(?:Find|Solve|Compute|Calculate|Determine|Show|Prove|Evaluate|Explain|Sketch|Draw|Derive|Simplify)\M`;
const jsStandaloneNumberedSolution = new RegExp(standaloneNumberedSolution, "iu");
const jsNumberedQuestion = new RegExp(numberedQuestion, "u");
const jsEnglishSolutionLabel = new RegExp(lineStart + englishSolutionLabel, "iu");
const sectionAnswerLine = String.raw`${lineStart}(?:${sectionAnswer}|解答${chineseContinuation}[:：]? *$)`;
const answerLabelLine = String.raw`${lineStart}(?:${sectionAnswer}|(?:${pdfHeadingContainer})?(?:${inlineAnswer}|${numberedAnswer}))`;
const explanationLabelLine = String.raw`${lineStart}(?:${pdfHeadingContainer})?(?:${standaloneEnglishSolution}|${numberedSolution}|【 *${chineseExplanation}${chineseContinuation}】|${chineseExplanation}${chineseContinuation}(?=[:：]|$)|(?:${chineseExplanation}|解) *(?:\d+(?:[.-]\d+)*)?${chineseContinuation}[:：]|(?:${chineseExplanation}|解) *\d+(?:[.-]\d+)*${chineseContinuation}(?:[、】]|[.。](?: |$)|$))`;
const answerLabel = new RegExp(answerLabelLine, "imu");
const jsQualifiedSolution = new RegExp(qualifiedSolutionLabel, "iu");
const explanationLabel = new RegExp(explanationLabelLine, "iu");
const jsAnswerPeriod = new RegExp(answerPeriodLine, "mu");
const jsSolutionPeriod = new RegExp(solutionPeriodLine, "u");
const jsAssessmentSolutionsHeading = new RegExp(assessmentSolutionsHeading, "imu");
const jsAssessmentSolutionsContext = new RegExp(asJsPattern(assessmentSolutionsContext), "iu");
const jsStandaloneAssessmentItem = new RegExp(standaloneAssessmentItem, "u");
const horizontalWhitespace = "[ \t\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+";
const pdfHorizontalWhitespace = new RegExp(horizontalWhitespace, "gu");
const closingAtxHashes = String.raw`^( *#{1,6}(?: +.*?)?) +#+ *$`;
const pdfClosingAtxHashes = new RegExp(closingAtxHashes, "gmu");

// Reopen at the first content line, so earlier answer text on a physical page
// cannot become public because a later line happens to look like a heading.
const markdownTitle = String.raw`#{1,6} +(?!(?:chapters?|sections?|parts?|units?|lectures?|lessons?|modules?|appendix)(?: |$)|第 *[一二三四五六七八九十百千\d]+|附录)[[:alpha:]一-龥]`;
const backMatterHeading = String.raw`(?:preface|introduction|bibliography|references|works +cited|index|subject +index|author +index|glossary|notation +index|acknowledg(?:e)?ments?|about +the +authors?|afterword|colophon|序言|前言|引言|参考文献|索引|名词索引|主题索引|符号表|词汇表|后记|致谢) *(?:[:：.—–-]|$)`;
const backMatterLine = lineStart + backMatterHeading;
const blockedReopeningHeading = [
  String.raw`${lineStart}(?:(?:(?:scanned|physical|printed|pdf) +)*(?:pages?|slides?)|(?:(?:cached|raw|readable|verified|automatic) +)*(?:transcription|ocr)|[ivxlcdm]+[.。]? *$)(?:[ :：]|$)`,
  String.raw`${lineStart}(?:(?:\d+|[a-z])[.)](?: |$)|[a-z] *$|[（(] *(?:\d+|[a-z]|[一二三四五六七八九十]+) *[)）])`,
  String.raw`${lineStart}(?:\d+(?:\.\d+)*[.)]? +)?(?:true|false|yes|no|none|[a-f](?: *, *[a-f])*)[.。]? *$`,
  String.raw`\m(?:answers?|solutions?|keys?|exercises?|problems?|questions?|review|practice|quiz|drills?|self[- ]check|homework|assignments?|problem +sets?|worksheets?|tutorials?|recitations?|labs?|continued|cont(?:['’]?d)?)\M`,
  String.raw`(?:pages?|slides?|pp?\.) *\d+ *(?:(?:of +|[/／–-] *)\d+ *)?[)）\]]? *[.。]?$|(?:第 *)?[\d一二三四五六七八九十百千]+(?: *(?:[/／–-]|共) *(?:第 *)?[\d一二三四五六七八九十百千]+)? *[页頁]`,
  String.raw`答案|解答|习题|练习|复习题|自测题|思考题|作业|课后题|单元测试|第 *[一二三四五六七八九十百千\d]+ *[题小题]|续上页|接上页|[（(] *续 *[）)]`,
  String.raw`${lineStart}(?:[\[【(] *)?(?:图表观察描述|识别不确定)`,
].join("|");

// Only extraction and transcription headers may precede a reopening heading.
const visionTranscription = String.raw`^ *(?:【原图忠实转写[^】]*】|\[转写\]) *[:：]? *$`;
const visionAuxiliary = String.raw`^ *(?:【(?:图表观察描述|识别不确定)[^】]*】|\[(?:图片描述|图像描述|图示与版面描述|不确定处)\]) *[:：]? *`;
const pdfLeadingTextWrappers = String.raw`^ *\[(?:原生提取|本地提取（可能含OCR）|视觉转写与描述)\] *$|${visionTranscription}`;
const jsVisionTranscription = new RegExp(visionTranscription, "u");
const jsVisionAuxiliary = new RegExp(visionAuxiliary, "u");
const jsPdfLeadingTextWrappers = new RegExp(pdfLeadingTextWrappers, "u");
const exerciseHeading = String.raw`${lineStart}(?:(?:exercises?|practice +problems?|(?:problem|question) +\d+)\M|习题|练习题?|思考题|作业题)`;
const qualifiedExerciseAnswer = String.raw`(?:参考答案|标准答案|正确答案|参考解答|详细解答)${chineseContinuation}[:：] *(?=[^ ])`;
const bracketedExerciseAnswer = String.raw`【 *正确答案 *】 *$`;
const exerciseSectionException = String.raw`${lineStart}(?:${bracketedExerciseAnswer}|答案 *[:：] *$|解答${chineseContinuation}[:：]? *$|${qualifiedExerciseAnswer})`;
const exerciseInlineAnswer = String.raw`${lineStart}(?:${bracketedExerciseAnswer}|【 *(?:答案|${chineseExplanation})${chineseContinuation}】 *[:：]? *|(?:答案|解|${chineseExplanation}) *(?:\d+(?:[.-]\d+)*)?${chineseContinuation}[:：] *|${chineseExplanation}${chineseContinuation}$|${qualifiedExerciseAnswer}|${numberedSolution} *|(?:(?:${englishAnswerQualifier} +)?answer(?: +key)?|(?:(?:worked|full|sample|official|reference) +)?solution)(?: +\d+(?:\.\d+)*)?${englishContinuation} *(?:[:：] *|$))`;
const standaloneInlineAnswer = String.raw`${lineStart}(?:(?:${englishAnswerQualifier} +)?answer(?: +\d+(?:\.\d+)*)?${englishContinuation} *[:：]|【 *答案${chineseContinuation}】 *[:：]?|${standaloneEnglishSolution}|解答${chineseContinuation}[:：]|${numberedSolution}) *$`;

const workedExampleHeading = String.raw`${lineStart}(?:${pdfHeadingContainer})?(?:(?:worked +example|example)(?= +\d| *[(:：.．—–-]| *$)|例题(?= *\d| *[（(:：.．—–-]| *$)|例 *(?=\d|[:：]))`;
const englishBlock = String.raw`(?:definition|notation|terminology|convention|theorem|lemma|proposition|corollary|axiom|conjecture|claim|proof(?: +of +(?:theorem|lemma|proposition|corollary))?)`;
const englishBlockPrefix = String.raw`${lineStart}${englishBlock}\M`;
const captionName = String.raw`(?:figure|fig\.?|table|tab\.?|chart|diagram|scheme|algorithm|listing)`;
const captionPrefix = String.raw`${lineStart}${captionName}(?= |[:：]|$)`;
const headingId = String.raw`(?:(?:[a-z][.-]?)?\d+(?:[.-]\d+)*[a-z]?|[ivxlcdm]+)(?=[ :：.．、—–(（-]|$)`;
const englishBlockReferencePrefix = String.raw`${lineStart}(?:(?:${englishBlock}|${captionName}) +${headingId}|${englishBlock}\M(?= *[(（]))`;
const englishContainerPrefix = String.raw`${lineStart}(?:(?:chapter|section|part|unit|lecture|lesson|module) +(?:\d+(?:\.\d+)*|[ivxlcdm]+)|appendix(?: +(?:[a-z](?![a-z\d])|\d+))?)(?=[ |:：.．—–(（-]|$)`;
const chineseContainerPrefix = String.raw`${lineStart}(?:第 *[一二三四五六七八九十百千\d]+ *(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课])|附录(?: *(?:[A-Z](?![a-z])|[0-9一二三四五六七八九十]+))?)`;
const chineseBlocks = "(?:定义|记号|术语|约定|定理|引理|推论|命题|公理|猜想|证明)";
const chineseCaption = "(?:插图|附表|算法|图|表)";
const chineseCaptionPrefix = String.raw`${lineStart}${chineseCaption} *\d`;
const chineseNumberedBlock = String.raw`${lineStart}(?:${chineseBlocks}|${chineseCaption}) *\d+(?:[.-]\d+)*[a-zA-Z]?(?![a-zA-Z\d])`;
const englishExamplePrefix = String.raw`${lineStart}(?:${pdfHeadingContainer})?(?:worked +)?example\M(?: +\d+(?:[.-]\d+)*)?`;
const chineseExamplePrefix = String.raw`${lineStart}(?:${pdfHeadingContainer})?(?:例题|例)(?= *[\d:：.．—–(（-]| *$)(?: *\d+(?:[.-]\d+)*)?`;
const headingQualifier = String.raw`(?: *(?:\([^()（）]*\)|（[^()（）]*）)| +[a-zA-Z](?= |[:：.．、—–(（-]|$))`;
const headingQualifiers = String.raw`^${headingQualifier}* *`;
const headingDelimiter = String.raw`(?:[:：．、—–]|\.(?!\d)|-(?!\d))`;
const referenceBodyStart = "[A-Za-z0-9一-鿿【「『〈《]";
const invalidReferenceBody = String.raw`^(?:${headingDelimiter}(?! *(?:$|${referenceBodyStart}))|(?!(?:${headingDelimiter}| *$|${referenceBodyStart})))`;
const englishReferenceVerb = String.raw`\m(?:am|is|are|was|were|has|have|had|can|will|gives|shows|lists|states|implies|requires|yields|equals|explains|approximates|denotes|represents|follows|illustrates|demonstrates|describes|contains|provides|depicts|presents|indicates|says|proves|discusses)\M`;
const englishReferenceProse = String.raw`${invalidReferenceBody}|, *(?:which|where|applied|used|shown|given|as)\M|^(?!${headingDelimiter})(?:[a-z]|.*[.!?;] *$|.*${englishReferenceVerb})|^${headingDelimiter} *(?:[a-z]+|This|That|It|They|We)\M.*${englishReferenceVerb}|^${headingDelimiter} *${englishReferenceVerb}`;
const qualifiedEnglishProse = String.raw`^${headingQualifier}+ *${headingDelimiter}.*${englishReferenceVerb}`;
const chineseReferenceProse = String.raw`${invalidReferenceBody}|^(?:${headingDelimiter} *)?(?:给出|显示|展示|表明|说明|证明|解释|指出|列出|描述|表示|讨论|介绍|包含|汇总|满足|成立|可由|由|中|里|内|上|下|的|是|为|有|在|与|和|将|把|对|见|如)|[，,].*(?:可得|得到|显示|表明|说明|给出|成立|满足)|^(?!${headingDelimiter}).*[。！？；] *$`;
const markdownProse = String.raw`[=<>≈]|[.!?;。！？；] *$|${englishReferenceVerb}|, *(?:which|where|applied|used|shown|given|as)\M|[，,].*(?:可得|得到|显示|表明|说明|给出|成立|满足)`;
const dottedSectionPrefix = String.raw`${lineStart}\d+(?:\.\d+)+ +`;
const latinSectionTitle = String.raw`^[A-Z][A-Za-z0-9'’&-]*(?:[ ,]+(?:[A-Z0-9][A-Za-z0-9'’&-]*|and|as|at|by|for|from|in|of|on|or|the|to|a|an|with|without|via)){0,12} *$`;
const cjkSectionTitle = "^[【「『〈《（(]?[一-鿿]";
const latinUnit = String.raw`(?:[kKMGTPEZYmunpfµμ]|da|d|c)?(?:V|A|W|J|N|C|F|H|T|S|K|M|B|G|L|l|m|g|s|h|b|Ω|Hz|Pa|Wb|Bq|Gy|Sv|lm|lx|cd|sr|mol|rad|deg|kat|bar|atm|psi|cal|eV|dB|rpm|mph|fps|min|sec|hrs?|iB|[KMGTPEZY]iB|volts?|amps?|watts?|joules?|meters?|metres?|seconds?|liters?|litres?|grams?|ft|yd|mi|in|lb|oz|Ah|Wh|hp|ac|qt)(?:\^?[+-]?\d+|[²³])?`;
const latinSectionUnits = String.raw`^(?!ML *$)${latinUnit}(?: *(?:[/·⋅*] *| +)${latinUnit})* *$`;
const cjkUnitAtom = "(?:平方|立方|千|毫|微|纳|皮|飞|吉|兆|太|分|厘|公|市|摄氏|华氏|十|百|万|亿)*(?:米|里|顷|亩|丈|尺|寸|斗|石|克|斤|两|吨|秒|分钟|分|小时|时|天|日|周|月|年|升|伏特|伏|安培|安|瓦特|瓦|焦耳|焦|牛顿|牛|帕斯卡|帕|赫兹|赫|欧姆|欧|法拉|法|亨利|亨|韦伯|韦|特斯拉|特|库仑|库|摩尔|摩|坎德拉|坎|流明|流|勒克斯|勒|贝可|贝|戈瑞|戈|希沃特|希|开尔文|开|弧度|弧|球面度|度|分贝|字节|比特|位|美元|欧元|日元|英镑|人民币|元|角|毛|块|倍|个|次|项|种|类|条|件|张|页|题|人|成|折)";
const cjkSectionUnits = String.raw`^(?:${cjkUnitAtom}(?:[·⋅/／每]?${cjkUnitAtom})*(?=$|[ /／每，。！？；、.,;:：)）]|(?:左右|以上|以下|以内|以外|的|是|为|重|长|宽|高))|[十百千万亿]+(?=$|[ ，。！？；、]))`;
const jsCjkSectionUnits = new RegExp(String.raw`^(?:(?=(${cjkUnitAtom}))\1(?:(?=([·⋅/／每]?${cjkUnitAtom}))\2)*(?=$|[ /／每，。！？；、.,;:：)）]|(?:左右|以上|以下|以内|以外|的|是|为|重|长|宽|高))|[十百千万亿]+(?=$|[ ，。！？；、]))`, "u");
const sectionProse = String.raw`[=<>≈%％。！？；]|[.!?;] *$|${englishReferenceVerb}|^(?:是|为|有(?!(?:限|理|界|向|效|序|机|源|偏|噪|穷))|在(?!(?:线|位|途)))|可得|得到|满足|成立|显示|表明|说明|实数解|整数解|唯一解|无解|有解|位于|属于|大于|小于|等于|${latinSectionUnits}|^(?:True|False|Yes|No|None|[A-F](?: *, *[A-F])*) *$`;
const appendixHeading = String.raw`${lineStart}(?:appendix(?= |[:：]|$)|附录)`;
const bareContainerSuffix = String.raw`^[ :：.．—–-]*$`;
const inlinePublicHeading = String.raw`${lineStart}(?:${englishBlock} *(?:[:：．—–]|\.(?!\d)|-(?!\d)|$)|${chineseBlocks} *(?:[:：]|$))`;
const answerProofHeading = String.raw`${lineStart}(?:(?:Proof|Sketch +of +Proof)\M|【 *(?:证明|证|略证|续证) *】|(?:证明|略证|续证)(?=[ \d:：.．。—–(（-]|$)|证 *[:：.．。])`;
const explicitHeadingMarkup = String.raw`^ *#{1,6} +[^ ]`;

const jsWorkedExample = new RegExp(workedExampleHeading, "iu");
const jsEnglishExample = new RegExp(asJsPattern(englishExamplePrefix), "iu");
const jsChineseExample = new RegExp(chineseExamplePrefix, "u");
const jsEnglishBlock = new RegExp(asJsPattern(englishBlockPrefix), "iu");
const jsBlockReference = new RegExp(asJsPattern(englishBlockReferencePrefix), "iu");
const jsChineseNumberedBlock = new RegExp(chineseNumberedBlock, "u");
const jsEnglishContainer = new RegExp(englishContainerPrefix, "iu");
const jsChineseContainer = new RegExp(chineseContainerPrefix, "u");
const jsHeadingQualifiers = new RegExp(headingQualifiers, "u");
const jsEnglishProse = new RegExp(englishReferenceProse.replaceAll(String.raw`\m`, String.raw`\b`).replaceAll(String.raw`\M`, String.raw`\b`), "u");
const jsQualifiedEnglishProse = new RegExp(qualifiedEnglishProse.replaceAll(String.raw`\m`, String.raw`\b`).replaceAll(String.raw`\M`, String.raw`\b`), "u");
const jsChineseProse = new RegExp(chineseReferenceProse, "u");
const jsDottedSection = new RegExp(dottedSectionPrefix, "u");
const jsLatinTitle = new RegExp(latinSectionTitle, "u");
const jsCjkTitle = new RegExp(cjkSectionTitle, "u");
const jsSectionProse = new RegExp(sectionProse.replaceAll(String.raw`\m`, String.raw`\b`).replaceAll(String.raw`\M`, String.raw`\b`), "u");
const jsPublicHeading = new RegExp(inlinePublicHeading, "iu");
const jsCaptionPrefix = new RegExp(captionPrefix, "iu");
const jsChineseCaptionPrefix = new RegExp(chineseCaptionPrefix, "u");
const jsMarkdownProse = new RegExp(asJsPattern(markdownProse), "u");
const jsMarkdownTitle = new RegExp(("^ *" + markdownTitle).replaceAll("[[:alpha:]一-龥]", "[\\p{L}]"), "iu");
const jsBackMatter = new RegExp(backMatterLine, "iu");
const jsBlockedReopening = new RegExp(blockedReopeningHeading.replaceAll(String.raw`\m`, String.raw`\b`).replaceAll(String.raw`\M`, String.raw`\b`), "iu");
const jsExerciseHeading = new RegExp(exerciseHeading.replace(String.raw`\M`, String.raw`\b`), "iu");
const jsExplicitHeading = new RegExp(explicitHeadingMarkup, "u");
const jsProofHeading = new RegExp(asJsPattern(answerProofHeading), "iu");

function asJsPattern(pattern: string): string {
  return pattern.replaceAll(String.raw`\m`, String.raw`\b`).replaceAll(String.raw`\M`, String.raw`\b`);
}

function acceptsPdfHeading(line: string, prefix: RegExpExecArray, prose: RegExp): boolean {
  const suffix = line.slice(prefix[0].length);
  return !prose.test(suffix.replace(jsHeadingQualifiers, ""))
    && (prose !== jsEnglishProse || !jsQualifiedEnglishProse.test(suffix));
}

export function containsPdfAnswerLabel(text: string, { checkContext = true } = {}): boolean {
  const normalized = text.replace(/\r/gu, "").replace(pdfHorizontalWhitespace, " ").replace(pdfClosingAtxHashes, "$1");
  const primary: { rawLine: string; line: string }[] = [];
  const blocks = [primary];
  let block = primary;
  for (const rawLine of normalized.split("\n")) {
    let line = rawLine.replace(/\*\*|__/gu, "");
    const auxiliaryHeader = jsVisionAuxiliary.exec(line);
    if (auxiliaryHeader) {
      block = [];
      blocks.push(block);
      line = line.slice(auxiliaryHeader[0].length);
    } else if (jsVisionTranscription.test(line)) block = primary;
    if (jsPdfLeadingTextWrappers.test(line) || !line.trim()) continue;
    if (answerLabel.test(line) || jsQualifiedSolution.test(line) || jsAnswerPeriod.test(line)) return true;
    if (!isArchiveRunningHeading(line) || jsStandaloneAssessmentItem.test(line)) block.push({ rawLine, line });
  }
  if (blocks.some(lines => lines.some(({ line }, index) => jsAssessmentSolutionsHeading.test(line)
    && jsAssessmentSolutionsContext.test(lines[index + 1]?.line ?? "")))) return true;
  if (!checkContext) return false;
  let inWorkedExample = false;
  for (const lines of blocks) {
    let previousNumberedQuestion = false;
    for (const { rawLine, line } of lines) {
      const followsNumberedQuestion = previousNumberedQuestion;
      previousNumberedQuestion = jsNumberedQuestion.test(line);
      if (explanationLabel.test(line) || jsEnglishSolutionLabel.test(line) || jsSolutionPeriod.test(line)) {
        if (!inWorkedExample || followsNumberedQuestion && jsStandaloneNumberedSolution.test(line)) return true;
        continue;
      }
      if (lines !== primary || jsProofHeading.test(line)) continue;
      const atx = jsExplicitHeading.test(rawLine);
      const englishExample = jsEnglishExample.exec(line);
      const chineseExample = jsChineseExample.exec(line);
      if (jsWorkedExample.test(line)
        && (!englishExample || acceptsPdfHeading(line, englishExample, jsEnglishProse))
        && (!chineseExample || acceptsPdfHeading(line, chineseExample, jsChineseProse))) {
        inWorkedExample = true;
      } else if (inWorkedExample) {
        const numbered = jsBlockReference.exec(line);
        const chinese = jsChineseNumberedBlock.exec(line) ?? jsChineseContainer.exec(line);
        const container = jsEnglishContainer.exec(line);
        const dotted = jsDottedSection.exec(line);
        const title = dotted ? line.slice(dotted[0].length) : "";
        const numberedSection = Boolean(dotted && (jsLatinTitle.test(title) && /[A-Za-z]{2}/u.test(title)
          || jsCjkTitle.test(title) && !jsCjkSectionUnits.test(title)) && !jsSectionProse.test(title));
        const genericHeading = atx && !dotted && !numbered && !chinese && !container && !englishExample && !chineseExample
          && !jsEnglishBlock.test(line) && !jsCaptionPrefix.test(line) && !jsChineseCaptionPrefix.test(line)
          && jsMarkdownTitle.test(line) && !jsMarkdownProse.test(line);
        if (jsExerciseHeading.test(line) || jsPublicHeading.test(line)
          || (numbered && acceptsPdfHeading(line, numbered, jsEnglishProse))
          || (chinese && acceptsPdfHeading(line, chinese, jsChineseProse))
          || ((container && acceptsPdfHeading(line, container, jsEnglishProse))
            || numberedSection || jsBackMatter.test(line) || genericHeading)
            && !jsBlockedReopening.test(line)) {
          inWorkedExample = false;
        }
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
const shortFurniturePrefix = String.raw`(?:(?:chapter|section|part|unit|lecture|lesson|module) +(?:\d+(?:\.\d+)*|[ivxlcdm]+)|第 *${chinesePageNumber} *(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课])) *[|:：—–-] *`;
const furnitureSeparator = String.raw`(?: *[|｜—–] *| +- +)`;
const furnitureTitleProse = String.raw`\m(?:on|see|at|pages?) +(?:page +)?\d+\M|[。！；!]|(?:见|参见)第 *\d+ *页`;
const pageCounter = String.raw`(?:[(（\[【]? *(?:(?:(?:scanned|physical|printed|pdf) +)*(?:pages?|slides?) +|pp?\. *)\d+(?: *(?:of +|[/／–—-] *)\d+)? *[)）\]】]?|${chineseCounter}) *[.。．、]?`;
const containerFurniture = String.raw`(?:(?:${englishContainerPrefix}|${chineseContainerPrefix}).*${furnitureSeparator}|${lineStart}${shortFurniturePrefix})${pageCounter} *$`;
const titledPageCounter = String.raw`${lineStart}([^|｜—–]{1,96}?)(?:${furnitureSeparator}| *[:：] +)${pageCounter} *$`;
const pageMetadataHeading = String.raw`${lineStart}(?:[\[【(] *)?(?:(?:cached|raw|readable|verified|automatic) +)*(?:transcription|ocr)\M`;
const continuedContainer = String.raw`(?:${englishContainerPrefix}|${chineseContainerPrefix}).*(?:[(（\[【] *(?:(?:to +be +)?${englishContinuationWord}|续|续上页|接上页) *[)）\]】]|\m${englishContinuationWord}(?: +(?:from|on) +.+)?|续上页|接上页| +续)[ .:：]*$`;
const inlineRunningHeading = String.raw`${lineStart}(?:\d+(?:\.\d+)*|[ivxlcdm]+ *[.。．、]?|[(（\[【] *${counter} *[)）\]】] *[.。．、]?|[-–—] *${counter} *[-–—] *[.。．、]?|${pageNumberRatio} *[)）\]】]? *[.。．、]?|${pageCounter}) *$|${containerFurniture}|${continuedContainer}|${pageMetadataHeading}`;
const jsInlineRunningHeading = new RegExp(asJsPattern(inlineRunningHeading), "iu");
const jsTitledPageCounter = new RegExp(titledPageCounter, "iu");
const jsFurnitureTitleProse = new RegExp(asJsPattern(furnitureTitleProse), "iu");
const jsEnglishReferenceVerb = new RegExp(asJsPattern(englishReferenceVerb), "u");

function isArchiveRunningHeading(line: string): boolean {
  if (jsInlineRunningHeading.test(line)) return true;
  const title = jsTitledPageCounter.exec(line)?.[1];
  return Boolean(title && !jsEnglishReferenceVerb.test(title) && !jsFurnitureTitleProse.test(title));
}
const inlineTerminal = String.raw`[.。!?！？;；)）\]】□■∎] *$`;
const inlineContinues = String.raw`(?:\( *(?:to +be +continued|continued(?: +on +next +page)?) *\)|[（(] *(?:下接下页|转下页|未完待续) *[）)]|接下页|转下页) *$`;
const answerSectionEnd = String.raw`(?:end +of +(?:answers?|solutions?)|答案完|解答完) *[.。]? *$`;
const inlineTerminator = String.raw`(?:[□■∎]|\\(?:Box|square|blacksquare)(?: *\$+|\\\)|\\\]|[)）\]】])?|\mQ\.?E\.?D\.?|证毕|证完|\mend +of +(?:answers?|solutions?)|答案完|解答完) *[.。]? *$`;

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
           OR seal.pages->0->>'inlineProofBoundaryPendingAtEnd'='true'
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
      (english_container IS NOT NULL AND english_container !~ ${qualifiedEnglishProse}
        AND regexp_replace(english_container,${headingQualifiers},'') !~ ${englishReferenceProse}
        OR chinese_container IS NOT NULL AND regexp_replace(chinese_container,${headingQualifiers},'') !~ ${chineseReferenceProse})
        AND line !~* ${blockedReopeningHeading} AS public_container,
      (english_numbered IS NOT NULL AND english_numbered !~ ${qualifiedEnglishProse}
        AND regexp_replace(english_numbered,${headingQualifiers},'') !~ ${englishReferenceProse}
        OR chinese_numbered IS NOT NULL AND regexp_replace(chinese_numbered,${headingQualifiers},'') !~ ${chineseReferenceProse}) AS public_numbered,
      (line ~* ${workedExampleHeading}
        AND (english_example IS NULL OR (english_example !~ ${qualifiedEnglishProse}
          AND regexp_replace(english_example,${headingQualifiers},'') !~ ${englishReferenceProse}))
        AND (chinese_example IS NULL OR regexp_replace(chinese_example,${headingQualifiers},'') !~ ${chineseReferenceProse})) AS public_example,
      (dotted_title IS NOT NULL AND (dotted_title ~ ${latinSectionTitle} AND dotted_title ~ '[A-Za-z]{2}'
        OR dotted_title ~ ${cjkSectionTitle} AND dotted_title !~ ${cjkSectionUnits})
        AND dotted_title !~ ${sectionProse} AND line !~* ${blockedReopeningHeading}) AS public_dotted,
      (line ~* ${backMatterLine} OR (atx AND line ~* ${"^ *" + markdownTitle}
        AND dotted_title IS NULL AND english_container IS NULL AND chinese_container IS NULL
        AND english_numbered IS NULL AND chinese_numbered IS NULL
        AND english_example IS NULL AND chinese_example IS NULL
        AND line !~* ${englishBlockPrefix} AND line !~* ${captionPrefix} AND line !~ ${chineseCaptionPrefix}
        AND line !~ ${markdownProse}))
        AND line !~* ${blockedReopeningHeading} AS other_reopening,
      (line ~* ${inlineRunningHeading} OR (furniture_title IS NOT NULL
        AND furniture_title !~ ${englishReferenceVerb} AND furniture_title !~* ${furnitureTitleProse})) AS running_heading
    FROM (
      SELECT *, coalesce(last_auxiliary>coalesce(last_transcription,0),false) AS auxiliary,
        raw_line ~ ${explicitHeadingMarkup} AS atx,
        NULLIF(regexp_replace(line,${englishContainerPrefix},'','i'),line) AS english_container,
        NULLIF(regexp_replace(line,${chineseContainerPrefix},''),line) AS chinese_container,
        NULLIF(regexp_replace(line,${englishBlockReferencePrefix},'','i'),line) AS english_numbered,
        NULLIF(regexp_replace(line,${chineseNumberedBlock},''),line) AS chinese_numbered,
        NULLIF(regexp_replace(line,${englishExamplePrefix},'','i'),line) AS english_example,
        NULLIF(regexp_replace(line,${chineseExamplePrefix},''),line) AS chinese_example,
        (regexp_match(line,${titledPageCounter},'i'))[1] AS furniture_title,
        NULLIF(regexp_replace(line,${dottedSectionPrefix},''),line) AS dotted_title
      FROM (
        SELECT id,source_id,source_version,page,created_at,raw_line,line_number,
          regexp_replace(line,${visionAuxiliary},'') AS line,
          max(line_number) FILTER (WHERE line ~ ${visionAuxiliary}) OVER vision_block AS last_auxiliary,
          max(line_number) FILTER (WHERE line ~ ${visionTranscription}) OVER vision_block AS last_transcription
        FROM (
          SELECT *,replace(replace(raw_line,'**',''),'__','') AS line
          FROM (
            SELECT id,source_id,source_version,page,created_at,unnest(lines) AS raw_line,
              generate_subscripts(lines,1) AS line_number
            FROM pdf_archive_text
          ) raw_lines
        ) vision_lines
        WINDOW vision_block AS (PARTITION BY id ORDER BY line_number ROWS UNBOUNDED PRECEDING)
      ) normalized_lines
    ) heading_suffixes
  ), pdf_archive_lines AS (
    SELECT id,source_id,source_version,page,line,running_heading,auxiliary,last_transcription IS NOT NULL AND NOT auxiliary AS transcription,
      row_number() OVER (PARTITION BY source_id,source_version ORDER BY page,created_at,id,line_number) AS position,
      NOT wrapper AND line ~* ${exerciseHeading} AS opens_exercise,
      NOT wrapper AND public_example AND NOT running_heading AS opens_worked_example,
      (line ~* ${inlinePublicHeading} OR public_example
        OR public_numbered OR public_container OR public_dotted OR other_reopening)
        AND NOT wrapper AND NOT running_heading AND line !~* ${answerProofHeading} AND NOT qualified_solution
        AND line !~* ${answerLabelLine} AND line !~* ${explanationLabelLine} AS opens_public,
      (other_reopening OR public_dotted OR public_example OR public_numbered OR line ~* ${inlinePublicHeading}
        OR public_container AND (line ~* ${appendixHeading} OR COALESCE(english_container,chinese_container) !~ ${bareContainerSuffix}))
        AND NOT wrapper AND NOT running_heading AND line !~* ${answerProofHeading}
        AND line !~* ${captionPrefix} AND line !~ ${chineseCaptionPrefix} AS reopens_section,
       (line ~* ${sectionAnswerLine} OR assessment_solutions) AS opens_section,
       (line ~* ${answerLabelLine} OR qualified_solution OR period_answer OR assessment_solutions) AS unconditional_answer,
       (line ~* ${explanationLabelLine} OR period_solution) AS explanation_label,
      period_answer OR period_solution AS period_inline,
      NOT wrapper AND line ~* ${lineStart + answerSectionEnd} AS section_terminator,
      line ~* ${exerciseSectionException} AS exercise_exception,
       NOT auxiliary AND content_line AND line ~* ${standaloneNumberedSolution} AND COALESCE(
         lag(line) OVER (PARTITION BY source_id,source_version,content_line,auxiliary_chunk,auxiliary_block
           ORDER BY page,created_at,id,line_number) ~ ${numberedQuestion},false)
        AS numbered_solution_candidate,
       qualified_solution,wrapper,auxiliary_block,content_line
    FROM (
      SELECT *, line ~ ${answerPeriodLine} AS period_answer, line ~ ${solutionPeriodLine} AS period_solution,
        line ~* ${qualifiedSolutionLabel} AS qualified_solution,
        content_line AND line ~* ${assessmentSolutionsHeading} AND COALESCE(
           lead(line) OVER (PARTITION BY id,content_line,auxiliary_block ORDER BY line_number)
             ~* ${assessmentSolutionsContext},false) AS assessment_solutions
      FROM (
         SELECT *, CASE WHEN auxiliary THEN id END AS auxiliary_chunk,
           CASE WHEN auxiliary THEN last_auxiliary END AS auxiliary_block,
           line !~* ${pdfLeadingTextWrappers} AND (NOT running_heading OR line ~ ${standaloneAssessmentItem})
          AND btrim(line)<>'' AS content_line
        FROM (
          SELECT *, auxiliary OR line ~* ${pdfLeadingTextWrappers} AS wrapper
          FROM pdf_archive_headings
        ) wrappers
      ) lookahead
    ) contextual
  ), pdf_archive_exercise_context AS (
    SELECT *, COALESCE(max(position) FILTER (WHERE opens_exercise) OVER context,0)
      > COALESCE(max(position) FILTER (WHERE (opens_section AND NOT exercise_exception)
        OR (opens_public AND NOT opens_exercise)) OVER context,0) AS in_exercise,
      COALESCE(max(position) FILTER (WHERE opens_worked_example) OVER context,0)
       > COALESCE(max(position) FILTER (WHERE unconditional_answer OR numbered_solution_candidate OR opens_exercise
        OR (opens_public AND NOT opens_worked_example)) OVER context,0) AS in_worked_example
    FROM pdf_archive_lines
    WINDOW context AS (PARTITION BY source_id,source_version ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
  ), pdf_archive_line_events AS (
    SELECT *, section_without_numbered AND NOT numbered_solution_candidate AS section_answer,
       explanation_label AND (NOT in_worked_example OR numbered_solution_candidate) AS sealed_explanation,
       (numbered_solution_candidate OR qualified_solution OR period_inline OR line ~* ${exerciseInlineAnswer}
        AND (in_exercise OR (unconditional_answer OR explanation_label) AND line ~* ${standaloneInlineAnswer}
          OR (unconditional_answer OR NOT in_worked_example) AND line ~* ${exerciseInlineAnswer + "[^ ]"}))
         AND (NOT opens_section OR exercise_exception OR numbered_solution_candidate)
         AND (unconditional_answer OR NOT in_worked_example OR NOT explanation_label OR numbered_solution_candidate) AS inline_opener
    FROM (
      SELECT *, opens_section AND NOT (in_exercise AND exercise_exception)
        AND NOT (in_worked_example AND explanation_label) AS section_without_numbered
      FROM pdf_archive_exercise_context
    ) with_section
  ), pdf_archive_inline_bodies AS (
    SELECT *,
      CASE WHEN inline_opener AND qualified_solution THEN btrim(regexp_replace(line,${qualifiedSolutionLabel},'','i'))
        WHEN inline_opener AND period_inline THEN btrim(regexp_replace(line,${exerciseInlineAnswerPeriod},''))
        WHEN inline_opener THEN btrim(regexp_replace(line,${exerciseInlineAnswer},'','i'))
         WHEN running_heading OR line ~* ${pdfLeadingTextWrappers} THEN '' ELSE btrim(line) END AS candidate_body,
      -- Carry each provisional section opener on its numbered predecessor so the
      -- seal windows can check the predecessor before the opener changes groups.
      CASE WHEN NOT auxiliary AND content_line
        AND lead(numbered_solution_candidate AND section_without_numbered) OVER content_order
        THEN lead(position) OVER content_order END AS next_numbered_section,
      lead(page) OVER content_order AS next_content_page,
      bool_or(sealed_explanation AND NOT numbered_solution_candidate OR auxiliary AND inline_opener) OVER (PARTITION BY id)
        OR bool_or(auxiliary AND inline_opener) OVER (PARTITION BY source_id,source_version,page) AS withheld_numbered_context,
      COALESCE(max(position) FILTER (WHERE section_answer) OVER preceding_lines,0)
        > COALESCE(max(position) FILTER (WHERE section_terminator OR reopens_section) OVER preceding_lines,0)
        AND NOT reopens_section AS in_sealed_section
    FROM pdf_archive_line_events
    WINDOW content_order AS (PARTITION BY source_id,source_version,content_line,auxiliary ORDER BY position),
      preceding_lines AS (PARTITION BY source_id,source_version ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
  ), pdf_archive_inline_starts AS (
    SELECT *, inline_opener AND NOT auxiliary_complete AS starts_inline,
      COALESCE(auxiliary_proof_head AND max(position) FILTER (WHERE auxiliary_answer_boundary) OVER earlier_on_page
        = max(position) FILTER (WHERE auxiliary AND content_line) OVER earlier_on_page
        OR (NOT auxiliary AND position=first_primary_position AND candidate_body ~* ${answerProofHeading}
          OR first_auxiliary_proof AND NOT primary_ends_adjacency)
          AND max(page) OVER previous_page=page-1
           AND max(position) FILTER (WHERE auxiliary_answer_boundary) OVER previous_page
             = max(position) FILTER (WHERE auxiliary AND content_line) OVER previous_page
        OR first_auxiliary_proof AND native_answer_boundary AND NOT transcription_reopens_answer,false) AS follows_completed_answer
    FROM (
      SELECT *, auxiliary_proof AND position=first_auxiliary_position AS auxiliary_proof_head,
        auxiliary_proof AND position=first_page_auxiliary_position AS first_auxiliary_proof,
        native_answer_position>COALESCE(native_reopening,0) AND native_answer_position>COALESCE(native_proof,0)
          AND (native_tail ~* ${inlineTerminator} OR native_tail ~* ${inlineTerminal} AND native_tail !~* ${inlineContinues}) AS native_answer_boundary,
        (max(position) FILTER (WHERE transcription AND inline_opener
          AND line=native_answer_line AND last_answer_body=native_tail AND transcription_reopening>last_transcription_answer)
          OVER chunk_lines IS NOT NULL) AS transcription_reopens_answer,
        auxiliary AND (last_answer_body ~* ${inlineTerminator}
          OR NOT open_auxiliary_proof AND (first_auxiliary_close IS NOT NULL OR auxiliary_sentence_ends)) AS auxiliary_complete,
        auxiliary AND content_line AND position=last_auxiliary_position AND auxiliary_opener>0 AND NOT open_auxiliary_proof
          AND CASE WHEN first_auxiliary_close IS NULL THEN auxiliary_sentence_ends
            ELSE first_auxiliary_close=position END AS auxiliary_answer_boundary
      FROM (
        SELECT *, NOT open_auxiliary_proof AND last_answer_body !~* ${inlineTerminator} AND last_answer_body ~* ${inlineTerminal}
            AND last_answer_body !~* ${inlineContinues} AS auxiliary_sentence_ends
        FROM (
          SELECT *, min(position) FILTER (WHERE NOT auxiliary AND content_line)
            OVER (PARTITION BY source_id,source_version,page) AS first_primary_position,
            min(position) FILTER (WHERE auxiliary AND content_line)
              OVER (PARTITION BY source_id,source_version,page) AS first_page_auxiliary_position,
            min(position) FILTER (WHERE content_line) OVER auxiliary_block_lines AS first_auxiliary_position,
            max(position) FILTER (WHERE content_line) OVER auxiliary_block_lines AS last_auxiliary_position,
            max(position) FILTER (WHERE NOT inline_opener AND candidate_terminator)
              OVER auxiliary_block_lines AS auxiliary_terminator,
            bool_or(NOT auxiliary AND (inline_opener OR section_answer OR opens_exercise OR opens_public
              OR content_line AND line ~ ${numberedQuestion}))
              OVER (PARTITION BY source_id,source_version,page) AS primary_ends_adjacency,
            first_value(candidate_body) OVER answer_body AS last_answer_body,
            min(position) FILTER (WHERE candidate_terminator AND NOT auxiliary_answer_proof_close) OVER answer_body AS first_auxiliary_close,
            COALESCE(max(position) FILTER (WHERE candidate_proof) OVER answer_body,0)
              > COALESCE(max(position) FILTER (WHERE candidate_terminator) OVER answer_body,0) AS open_auxiliary_proof,
            max(position) FILTER (WHERE native_line AND inline_opener) OVER chunk_lines AS native_answer_position,
            max(position) FILTER (WHERE native_line AND lane_reopening) OVER chunk_lines AS native_reopening,
            max(position) FILTER (WHERE native_line AND candidate_proof) OVER chunk_lines AS native_proof,
            max(position) FILTER (WHERE transcription AND inline_opener) OVER chunk_lines AS last_transcription_answer,
            first_value(line) OVER (PARTITION BY id ORDER BY NOT (native_line AND inline_opener),position DESC) AS native_answer_line,
            first_value(candidate_body) OVER (PARTITION BY id ORDER BY NOT native_line OR candidate_body='',position DESC) AS native_tail
          FROM (
             SELECT *, auxiliary AND auxiliary_opener>0 AND candidate_terminator
               AND COALESCE(max(position) FILTER (WHERE candidate_proof) OVER auxiliary_progress,0)
                 > COALESCE(max(position) FILTER (WHERE candidate_terminator) OVER auxiliary_prior,0) AS auxiliary_answer_proof_close,
               min(position) FILTER (WHERE transcription AND lane_reopening) OVER answer_lanes AS transcription_reopening
             FROM (
               SELECT *, auxiliary AND content_line AND NOT inline_opener AND candidate_body ~* ${answerProofHeading} AS auxiliary_proof,
                 candidate_body ~* ${answerProofHeading} AS candidate_proof,
                 candidate_body ~* ${inlineTerminator} AS candidate_terminator,
                 NOT auxiliary AND NOT transcription AND content_line AS native_line,
                 opens_exercise OR opens_public OR section_answer OR line ~ ${numberedExerciseInstruction} AS lane_reopening,
                 count(*) FILTER (WHERE inline_opener)
                 OVER (PARTITION BY id,auxiliary_block,transcription ORDER BY position ROWS UNBOUNDED PRECEDING) AS auxiliary_opener
               FROM pdf_archive_inline_bodies
             ) with_openers
             WINDOW auxiliary_progress AS (PARTITION BY id,auxiliary_block,auxiliary_opener ORDER BY position ROWS UNBOUNDED PRECEDING),
               auxiliary_prior AS (PARTITION BY id,auxiliary_block,auxiliary_opener ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
               answer_lanes AS (PARTITION BY id,auxiliary_block,transcription,auxiliary_opener)
           ) with_proof_closes
          WINDOW auxiliary_block_lines AS (PARTITION BY id,auxiliary_block),
            chunk_lines AS (PARTITION BY id),
            answer_body AS (PARTITION BY id,auxiliary_block,transcription,auxiliary_opener
              ORDER BY (candidate_body='' OR COALESCE(position>=transcription_reopening,false)),position DESC
              ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
        ) with_auxiliary_body
      ) with_sentence_end
      WINDOW chunk_lines AS (PARTITION BY id)
    ) with_completion
    WINDOW earlier_on_page AS (PARTITION BY source_id,source_version,page ORDER BY position
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
      previous_page AS (PARTITION BY source_id,source_version ORDER BY page GROUPS BETWEEN 1 PRECEDING AND 1 PRECEDING)
  ), pdf_archive_inline_groups AS (
    -- An opener and its continuation lines share a group until the next explicit boundary.
    SELECT *, CASE WHEN NOT auxiliary OR first_value(starts_inline) OVER inline_origin
        AND id=first_value(id) OVER inline_origin
        AND auxiliary_block IS NOT DISTINCT FROM first_value(auxiliary_block) OVER inline_origin
      THEN candidate_body ELSE '' END AS body_line,
      -- An auxiliary proof that closes in its own block leaves the outer answer active.
      (auxiliary_proof AND NOT (first_auxiliary_proof AND native_answer_boundary AND transcription_reopens_answer)
        OR auxiliary AND inline_opener AND candidate_proof AND NOT candidate_terminator)
        AND first_value(starts_inline) OVER inline_origin
        AND (auxiliary_terminator IS NULL OR auxiliary_terminator<position) AS upgrades_inline
    FROM (
      SELECT *, count(*) FILTER (WHERE starts_inline OR section_answer OR opens_exercise OR opens_public)
        OVER (PARTITION BY source_id,source_version ORDER BY position ROWS UNBOUNDED PRECEDING) AS inline_group
      FROM pdf_archive_inline_starts
    ) grouped_lines
    WINDOW inline_origin AS (PARTITION BY source_id,source_version,inline_group ORDER BY position)
  ), pdf_archive_inline_body AS (
    SELECT *, min(position) FILTER (WHERE body_line<>'')
      OVER (PARTITION BY source_id,source_version,inline_group,page) AS first_body,
      min(position) FILTER (WHERE upgrades_inline OR NOT auxiliary AND body_line ~* ${answerProofHeading})
      OVER (PARTITION BY source_id,source_version,inline_group) AS first_proof,
      min(position) FILTER (WHERE body_line<>'')
      OVER (PARTITION BY source_id,source_version,inline_group,page ORDER BY position DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS next_body
    FROM pdf_archive_inline_groups
  ), pdf_archive_inline_closes AS (
    SELECT *, min(position) FILTER (WHERE closes_after_blank OR explicit_inline_close)
        OVER (PARTITION BY source_id,source_version,inline_group,page) AS first_inline_close
    FROM (
      SELECT *, NOT auxiliary AND btrim(line)='' AND position>first_body AND next_body IS NOT NULL
        AND (first_proof IS NULL OR next_body<first_proof) AS closes_after_blank,
        body_line ~* ${inlineTerminator} AND NOT auxiliary_answer_proof_close AS explicit_inline_close
      FROM pdf_archive_inline_body
    ) close_events
  ), pdf_archive_inline_pages AS (
    SELECT source_id,source_version,inline_group,page,bool_or(starts_inline) AS starts_inline,
      min(position) AS first_position,
      bool_or(NOT auxiliary AND (starts_inline OR section_answer OR opens_exercise OR opens_public)) AS primary_boundary,
      min(position) FILTER (WHERE position=first_proof) AS proof_position,
      min(position) FILTER (WHERE NOT auxiliary AND position=first_proof) AS primary_proof_position,
      min(position) FILTER (WHERE NOT auxiliary AND explicit_inline_close AND position>=first_proof) AS primary_proof_close,
      min(position) FILTER (WHERE follows_completed_answer) AS auxiliary_proof_position,
      max(position) FILTER (WHERE follows_completed_answer AND auxiliary
        AND (auxiliary_terminator IS NULL OR auxiliary_terminator<position)) AS unclosed_auxiliary_proof,
      max(position) FILTER (WHERE follows_completed_answer AND NOT auxiliary
        AND (NOT explicit_inline_close)) AS adjacent_primary_proof,
      min(position) FILTER (WHERE first_auxiliary_proof AND NOT primary_ends_adjacency) AS adjacent_auxiliary_position,
      min(position) FILTER (WHERE first_auxiliary_proof AND NOT primary_ends_adjacency
        AND (auxiliary_terminator IS NULL OR auxiliary_terminator<position)) AS unclosed_adjacent_auxiliary_proof,
      min(position) FILTER (WHERE NOT auxiliary AND explicit_inline_close) AS first_primary_terminator,
      max(position) FILTER (WHERE NOT auxiliary AND explicit_inline_close) AS primary_terminator,
      bool_or(starts_inline AND NOT (unconditional_answer OR sealed_explanation)) AS hide_opening_page,
      (array_agg(body_line ORDER BY position DESC) FILTER (WHERE body_line<>''))[1] AS last_body,
      bool_or(closes_after_blank) AS closed_after_blank,
      bool_or(first_proof<=position) AS in_sealed_proof,
      bool_or(NOT auxiliary AND position=first_body AND position=first_proof) AS starts_proof,
      min(position) FILTER (WHERE explicit_inline_close) AS terminator_position,
      max(position) FILTER (WHERE body_line<>'') AS last_body_position,
      min(next_numbered_section) AS numbered_section_position,
      min(next_content_page) FILTER (WHERE next_numbered_section IS NOT NULL) AS numbered_section_page,
      min(position) FILTER (WHERE next_numbered_section IS NOT NULL) AS numbered_predecessor,
      bool_or(next_numbered_section IS NOT NULL AND (in_sealed_section OR withheld_numbered_context)) AS numbered_withheld,
      bool_or(next_numbered_section IS NOT NULL AND inside_inline_body) AS numbered_in_inline
    FROM (
      SELECT *, first_inline_close IS NULL OR position<=first_inline_close AS inside_inline_body
      FROM pdf_archive_inline_closes
    ) with_line_closes
    GROUP BY source_id,source_version,inline_group,page
  ), pdf_archive_inline_ranges AS (
    -- A finished answer affects later pages only up to its first closing page.
    SELECT *, min(page) FILTER (WHERE starts_inline) OVER answer AS first_page,
      bool_or(hide_opening_page) OVER answer AS hide_first_page,
      COALESCE(min(page) FILTER (WHERE closed_after_blank
        OR (terminator_position IS NOT NULL AND (in_sealed_proof IS TRUE
          OR terminator_position<last_body_position OR continues_into_proof IS NOT TRUE))
        OR (in_sealed_proof IS NOT TRUE AND continues_into_proof IS NOT TRUE
          AND last_body ~* ${inlineTerminal} AND last_body !~* ${inlineContinues})) OVER answer,max(page) OVER answer) AS last_page
    FROM (
      SELECT *, lead(page) OVER next_page=page+1 AND lead(starts_proof) OVER next_page AS continues_into_proof
      FROM pdf_archive_inline_pages
      WINDOW next_page AS (PARTITION BY source_id,source_version,inline_group ORDER BY page)
    ) with_next_page
    WINDOW answer AS (PARTITION BY source_id,source_version,inline_group)
  ), pdf_archive_proof_ranges AS (
    -- A completed answer can start a fresh proof on the adjacent page.
    -- A terminator in that proof's opening block only closes that proof.
    SELECT source_id,source_version,page,first_page,last_page,proof_start,first_primary_terminator,
      primary_proof_position,primary_proof_close,numbered_section_position,numbered_section_page,
      numbered_predecessor,numbered_withheld,numbered_in_inline,
      CASE WHEN unclosed_proof_start IS NULL THEN page
        ELSE COALESCE(min(page) FILTER (WHERE primary_terminator>=COALESCE(unclosed_proof_start,first_position))
          OVER remaining,max(page) OVER remaining) END AS proof_end
    FROM (
      SELECT *, LEAST(auxiliary_proof_position,
        CASE WHEN follows_finished_inline THEN adjacent_auxiliary_position END,
        active_inline_proof) AS proof_start,
        GREATEST(unclosed_auxiliary_proof,adjacent_primary_proof,
          CASE WHEN follows_finished_inline THEN unclosed_adjacent_auxiliary_proof END,
          CASE WHEN primary_proof_close IS NULL THEN active_inline_proof END) AS unclosed_proof_start,
        count(*) FILTER (WHERE primary_boundary) OVER (PARTITION BY source_id,source_version ORDER BY first_position
          ROWS UNBOUNDED PRECEDING) AS primary_group
      FROM (
        SELECT *, CASE WHEN first_page IS NOT NULL AND page<=last_page AND closed_after_blank IS NOT TRUE
            THEN proof_position END AS active_inline_proof,
          lag(page) OVER previous_page=page-1 AND lag(page=last_page AND first_page IS NOT NULL
          AND in_sealed_proof IS NOT TRUE AND NOT closed_after_blank
          AND (terminator_position=last_body_position OR last_body ~* ${inlineTerminal} AND last_body !~* ${inlineContinues}))
          OVER previous_page AS follows_finished_inline
        FROM pdf_archive_inline_ranges
        WINDOW previous_page AS (PARTITION BY source_id,source_version,inline_group ORDER BY page)
      ) adjacent
    ) proof_groups
    WINDOW remaining AS (PARTITION BY source_id,source_version,primary_group ORDER BY first_position DESC
      ROWS UNBOUNDED PRECEDING)
  ), pdf_archive_numbered_predecessors AS (
    SELECT *, max(proof_end) FILTER (WHERE proof_start IS NOT NULL) OVER prior_pages AS earlier_proof_end,
      min(first_primary_terminator) OVER same_page AS first_page_primary_terminator,
      bool_or(proof_start IS NOT NULL AND proof_end>page) OVER same_page AS same_page_proof_open
    FROM pdf_archive_proof_ranges
    WINDOW same_page AS (PARTITION BY source_id,source_version,page),
      prior_pages AS (PARTITION BY source_id,source_version ORDER BY page
      GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
  ), pdf_archive_page_events AS (
    SELECT source_id,source_version,page,bool_or(section_answer) AS section_answer,
      bool_or(answer_label) AS answer_label,
      max(position) FILTER (WHERE section_terminator) > COALESCE(max(position) FILTER (WHERE section_answer),0) AS section_ends_here,
      (array_agg(reopens_section ORDER BY position) FILTER (WHERE reopens_section IS NOT NULL))[1] AS reopens_section
    FROM (
      SELECT source_id,source_version,page,position,section_answer,
        inline_opener OR unconditional_answer OR sealed_explanation AS answer_label,section_terminator,
        CASE WHEN NOT wrapper AND btrim(line)<>'' AND NOT running_heading THEN reopens_section END AS reopens_section
      FROM pdf_archive_line_events
      UNION ALL
      SELECT source_id,source_version,numbered_section_page,numbered_section_position,true,true,false,NULL::boolean
      FROM pdf_archive_numbered_predecessors
      WHERE numbered_section_position IS NOT NULL
        AND (numbered_withheld OR numbered_in_inline AND first_page IS NOT NULL AND page<=last_page
          OR page<earlier_proof_end OR page=earlier_proof_end
            AND (first_page_primary_terminator IS NULL OR numbered_predecessor<=first_page_primary_terminator)
          OR same_page_proof_open OR proof_start=primary_proof_position
            AND numbered_predecessor BETWEEN proof_start AND primary_proof_close)
    ) sections
    GROUP BY source_id,source_version,page
  ), pdf_archive_sealed_spans AS MATERIALIZED (
    SELECT source_id,source_version,first_page,reopen_page,NULL::uuid AS chunk_id FROM (
      SELECT source_id,source_version,page AS first_page,section_answer,
        CASE WHEN section_ends_here THEN page+1 ELSE
          lead(CASE WHEN section_ends_here AND NOT section_answer THEN page+1 ELSE page END)
            OVER (PARTITION BY source_id,source_version ORDER BY page) END AS reopen_page
      FROM pdf_archive_page_events
      WHERE section_answer OR section_ends_here OR (NOT answer_label AND reopens_section)
    ) events WHERE section_answer
    UNION ALL
    SELECT source_id,source_version,first_page,last_page+1,NULL::uuid
    FROM pdf_archive_inline_ranges WHERE starts_inline AND (first_page<last_page OR hide_first_page)
    UNION ALL
    SELECT source_id,source_version,page,proof_end+1,NULL::uuid
    FROM pdf_archive_proof_ranges WHERE proof_start IS NOT NULL
    UNION ALL
    SELECT DISTINCT source_id,source_version,page,page+1,id
    FROM pdf_archive_line_events WHERE sealed_explanation OR (auxiliary AND inline_opener)
  ), pdf_archive_sealed_pages AS MATERIALIZED (
    -- A page is sealed if any span started by that page is unbounded or ends later.
    SELECT source_id,source_version,page FROM (
      SELECT source_id,source_version,page,
        bool_or(unbounded) OVER prior_pages OR max(reopen_page) OVER prior_pages>page AS sealed
      FROM (
        SELECT source_id,source_version,page,bool_or(unbounded) AS unbounded,max(reopen_page) AS reopen_page
        FROM (
          SELECT DISTINCT source_id,source_version,page,false AS unbounded,NULL::int AS reopen_page
          FROM pdf_archive_text
          UNION ALL
          SELECT source_id,source_version,first_page,reopen_page IS NULL,reopen_page
          FROM pdf_archive_sealed_spans WHERE chunk_id IS NULL
        ) page_events
        GROUP BY source_id,source_version,page
      ) page_ranges
      WINDOW prior_pages AS (PARTITION BY source_id,source_version ORDER BY page ROWS UNBOUNDED PRECEDING)
    ) page_seals WHERE sealed
  ), pdf_archive_sealed_chunks AS MATERIALIZED (
    SELECT DISTINCT chunk_id FROM pdf_archive_sealed_spans WHERE chunk_id IS NOT NULL
  )`;
}

/** Chunk and source aliases are c and s at each publication read. */
export function publicPdfChunkPredicate(sql: Sql, { checkArchive = true } = {}) {
  return sql`(s.mime<>'application/pdf' OR c.page IS NULL OR (
    NOT EXISTS (
      SELECT 1 FROM pdf_pending_seals boundary
      WHERE boundary.source_id=c.source_id AND boundary.source_version=c.source_version AND boundary.first_page<=c.page
    ) ${checkArchive ? sql`AND NOT EXISTS (
      SELECT 1 FROM pdf_archive_sealed_pages archived_page
      WHERE archived_page.source_id=c.source_id AND archived_page.source_version=c.source_version AND archived_page.page=c.page
    ) AND NOT EXISTS (
      SELECT 1 FROM pdf_archive_sealed_chunks archived_chunk WHERE archived_chunk.chunk_id=c.id
    )` : sql``} AND NOT EXISTS (
      SELECT 1 FROM opening_pdf_parse_segments seal
      WHERE seal.workspace_id=s.workspace_id AND seal.source_id=c.source_id AND seal.source_version=c.source_version
        AND seal.parser_profile='pdf-publication-page-seal-v1' AND seal.state='ready'
        AND seal.page_start=c.page AND seal.page_end=c.page
        AND (seal.pages->0->>'hadSealedContent'='true' OR seal.pages->0->>'inlineSealedAtEnd'='true'
          OR seal.pages->0->>'inlineProofBoundaryPendingAtEnd'='true'
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
