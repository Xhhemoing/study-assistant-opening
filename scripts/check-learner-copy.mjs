#!/usr/bin/env node
/**
 * Learner-facing copy lint (report-only by default; --strict exits 1 on hits).
 * Scans string literals / JSX text containing CJK in apps/web/src/features + app (excluding api, tests)
 * and flags system/implementation jargon that should never reach a learner.
 * Usage: node scripts/check-learner-copy.mjs [--strict] [--json] [paths...]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const JARGON = [
  "回执", "权威", "快照", "幂等", "租约", "账本", "服务端", "客户端", "内容版本", "路径版本", "版本号", "规格", "锚点",
  "契约", "原请求", "同一请求", "已停止写入", "暂停写入", "写入", "投影", "字段", "协议", "门禁", "落库", "持久化", "身份不一致",
  "校验", "状态机", "提交标识", "交付", "核验", "未核实", "暴露", "会话 ID", "活动身份", "材料身份",
];
const ASCII_JARGON = /\b(client-init|clientKey|payload|schema|snapshot|receipt|exposure|idempot\w*|request failed|workspace|attemptId|sessionId|activityId|null|undefined|NaN|409|422|500)\b/;
const CJK = /[\u4e00-\u9fff]/;
const args = process.argv.slice(2);
const strict = args.includes("--strict"), asJson = args.includes("--json");
const roots = args.filter(a => !a.startsWith("--"));
const targets = roots.length ? roots : ["apps/web/src/features", "apps/web/src/app"];
const hits = [];
function walk(p) {
  const s = statSync(p);
  if (s.isDirectory()) { if (/[\\/]api$|node_modules|__tests__/.test(p)) return; for (const e of readdirSync(p)) walk(path.join(p, e)); return; }
  if (!/\.tsx?$/.test(p) || /\.(test|spec)\.tsx?$/.test(p) || /[\\/]server[\\/]|-service\.ts$|[\\/]v3[\\/]shell[\\/]features\.ts$/.test(p)) return;
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || line.includes("learner-copy-ignore")) return;
    // string literals + JSX text segments
    const segs = [...line.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`|'([^'\\]*)'|>([^<>{}]+)</g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]).filter(Boolean);
    for (const seg of segs) {
      if (!CJK.test(seg)) continue;
      const words = JARGON.filter(w => seg.includes(w));
      const ascii = seg.match(ASCII_JARGON)?.[0];
      if (words.length || ascii) hits.push({ file: p, line: i + 1, terms: [...words, ...(ascii ? [ascii] : [])], text: seg.trim().slice(0, 120) });
    }
  });
}
for (const t of targets) walk(t);
if (asJson) console.log(JSON.stringify(hits, null, 1));
else { for (const h of hits) console.log(`${h.file}:${h.line}\t[${h.terms.join(",")}]\t${h.text}`); console.log(`\n${hits.length} learner-copy findings`); }
process.exit(strict && hits.length ? 1 : 0);
