#!/usr/bin/env node
/**
 * Learner-facing copy lint (report-only by default; --strict exits 1 on hits).
 * Scans string literals / JSX text containing CJK in apps/web/src/features + app (excluding api, tests).
 * A same-line comment may use learner-copy-ignore: <specific reason> for an intentional exception.
 * Usage: node scripts/check-learner-copy.mjs [--strict] [--json] [paths...]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const JARGON = [
  "回执", "权威", "快照", "幂等", "租约", "账本", "服务端", "客户端", "内容版本", "路径版本", "版本号", "规格", "锚点",
  "契约", "原请求", "同一请求", "已停止写入", "暂停写入", "写入", "投影", "字段", "协议", "门禁", "落库", "持久化", "身份不一致",
  "校验", "状态机", "提交标识", "交付", "核验", "未核实", "暴露", "会话 ID", "活动身份", "材料身份",
  "无每", "推断", "生效层", "优先层", "资格", "影子",
];
const ASCII_JARGON = /\b(client-init|clientKey|payload|schema|snapshot|receipt|exposure|idempot\w*|request failed|workspace|attemptId|sessionId|activityId|null|undefined|NaN|409|422|500)\b/;
const CJK = /[\u4e00-\u9fff]/;
const args = process.argv.slice(2);
const strict = args.includes("--strict"), asJson = args.includes("--json");
const roots = args.filter(a => !a.startsWith("--"));
const targets = roots.length ? roots : ["apps/web/src/features", "apps/web/src/app"];
const hits = [];

function scanFile(file) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const segments = [], literals = [];
  function visit(node) {
    const templatePart = node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || templatePart || ts.isJsxText(node)) {
      const start = ts.isJsxText(node) ? node.pos : node.getStart(source);
      const template = templatePart && ts.isTemplateSpan(node.parent) ? node.parent.parent : node.parent;
      const cjkContext = CJK.test(node.text) || (templatePart && ts.isTemplateExpression(template)
        && [template.head, ...template.templateSpans.map(span => span.literal)].some(part => CJK.test(part.text)));
      segments.push({ text: node.text, start, end: node.end, cjkContext });
      literals.push({ start, end: node.end });
    } else if (ts.isRegularExpressionLiteral(node)) {
      literals.push({ start: node.getStart(source), end: node.end });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  // Mask literal contents before reading comments. Displayed marker text is never an exception.
  let position = 0;
  const masked = [];
  for (const literal of literals.sort((a, b) => a.start - b.start)) {
    masked.push(text.slice(position, literal.start), text.slice(literal.start, literal.end).replace(/[^\r\n]/g, " "));
    position = literal.end;
  }
  masked.push(text.slice(position));
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, masked.join(""));
  const ignoredLines = new Set();
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const comment = scanner.getTokenText().replace(/^\/\/|^\/\*|\*\/$/g, "").trim();
    if (/^learner-copy-ignore\s*:\s*\S[^\r\n]*$/.test(comment)) ignoredLines.add(source.getLineAndCharacterOfPosition(scanner.getTokenPos()).line);
  }

  for (const segment of segments) {
    const firstLine = source.getLineAndCharacterOfPosition(segment.start).line;
    const lastLine = source.getLineAndCharacterOfPosition(segment.end).line;
    segment.text.split(/\r?\n/).forEach((line, offset) => {
      const lineNumber = Math.min(firstLine + offset, lastLine);
      if (ignoredLines.has(lineNumber) || !segment.cjkContext) return;
      const words = JARGON.filter(word => line.includes(word));
      const ascii = line.match(ASCII_JARGON)?.[0];
      if (words.length || ascii) hits.push({ file, line: lineNumber + 1, terms: [...words, ...(ascii ? [ascii] : [])], text: line.trim().slice(0, 120) });
    });
  }
}

function walk(file) {
  const normalized = file.replaceAll("\\", "/");
  if (/(?:^|\/)(?:api|server|node_modules|__tests__)(?:\/|$)/.test(normalized)) return;
  const stat = statSync(file);
  if (stat.isDirectory()) { for (const entry of readdirSync(file)) walk(path.join(file, entry)); return; }
  if (!/\.tsx?$/.test(file) || /\.(test|spec)\.tsx?$/.test(file) || /-service\.ts$|\/v3\/shell\/features\.ts$/.test(normalized)) return;
  scanFile(file);
}
for (const target of targets) walk(target);
if (asJson) console.log(JSON.stringify(hits, null, 1));
else { for (const hit of hits) console.log(`${hit.file}:${hit.line}\t[${hit.terms.join(",")}]\t${hit.text}`); console.log(`\n${hits.length} learner-copy findings`); }
process.exit(strict && hits.length ? 1 : 0);
