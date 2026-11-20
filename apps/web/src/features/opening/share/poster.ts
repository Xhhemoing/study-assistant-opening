import { hasDisallowedXmlOrControlChars, toDisplayShareCard, type ShareCardData } from "./schema";

export function stripXmlIllegalChars(value: string): string {
  let result = "";
  for (const char of value) {
    if (!hasDisallowedXmlOrControlChars(char)) result += char;
  }
  return result;
}

export function escapeXml(value: string): string {
  return stripXmlIllegalChars(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function charDisplayWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

export function wrapPosterLines(
  text: string,
  maxUnitsPerLine: number,
  maxLines: number,
): string[] {
  const normalized = stripXmlIllegalChars(text).replace(/\s+/g, " ").trim();
  if (!normalized || maxLines <= 0) return [];

  const chars = [...normalized];
  const lines: string[] = [];
  let current = "";
  let units = 0;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const width = charDisplayWidth(ch);
    if (units + width > maxUnitsPerLine && current.length > 0) {
      if (lines.length + 1 >= maxLines) {
        const trimmedChars = [...current.trimEnd()];
        lines.push(`${trimmedChars.slice(0, Math.max(1, trimmedChars.length - 1)).join("")}…`);
        return lines;
      }
      // Prefer breaking on the last ASCII space inside the current line if close to the edge.
      const lastSpace = current.lastIndexOf(" ");
      if (lastSpace > current.length * 0.55 && width === 1 && ch !== " ") {
        const head = current.slice(0, lastSpace).trimEnd();
        const tail = current.slice(lastSpace + 1);
        lines.push(head);
        current = tail + ch;
        units = [...current].reduce((sum, c) => sum + charDisplayWidth(c), 0);
      } else {
        lines.push(current.trimEnd());
        current = ch === " " ? "" : ch;
        units = ch === " " ? 0 : width;
      }
    } else {
      if (current.length === 0 && ch === " ") continue;
      current += ch;
      units += width;
    }
  }

  if (current.trim().length > 0 && lines.length < maxLines) {
    lines.push(current.trimEnd());
  }
  return lines;
}

function renderTspans(lines: string[], x: number, lineHeight: number): string {
  return lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");
}

export function buildPosterFilename(
  card: Pick<ShareCardData, "subjectLabel" | "pitfallTitle">,
): string {
  const slug = `${card.subjectLabel}-${card.pitfallTitle}`
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug ? `aistudy-${slug}.svg` : "aistudy-pitfall-card.svg";
}

/**
 * Build a deterministic, pure XML-escaped paper-aesthetic SVG poster.
 * Contains zero scripts, foreignObject nodes, or external URLs.
 */
export function buildPitfallPosterSvg(input: ShareCardData, publicTryEnabled = true): string {
  const card = toDisplayShareCard(input);

  const width = 900;
  const height = 1200;
  const cardX = 56;
  const cardY = 56;
  const cardW = width - cardX * 2;
  const cardH = height - cardY * 2;

  const titleLines = wrapPosterLines(card.pitfallTitle, 28, 3);
  const trapLines = wrapPosterLines(card.trapSummary, 44, 5);
  const ruleLines = wrapPosterLines(card.takeawayRule, 44, 5);

  const hasCohortBadge = card.cohortTrapRate !== null;
  const cohortText = hasCohortBadge
    ? `约 ${card.cohortTrapRate}% 同学曾在此踩坑 · ${card.cohortSampleSize} 人样本`
    : null;

  const titleStartY = 236;
  const titleLineHeight = 52;
  const titleBottomY = titleStartY + Math.max(1, titleLines.length - 1) * titleLineHeight + 24;

  const badgeY = titleBottomY + 14;
  const trapBoxY = hasCohortBadge ? badgeY + 62 : titleBottomY + 24;
  const trapBoxH = Math.max(210, 86 + trapLines.length * 38);

  const ruleBoxY = trapBoxY + trapBoxH + 28;
  const ruleBoxH = Math.max(210, 86 + ruleLines.length * 38);

  const subjectWidth = Math.min(
    460,
    Math.max(120, [...card.subjectLabel].reduce((s, c) => s + charDisplayWidth(c), 0) * 11 + 48),
  );

  const cohortBadgeWidth = cohortText
    ? Math.min(
        684,
        Math.max(260, [...cohortText].reduce((s, c) => s + charDisplayWidth(c), 0) * 10.5 + 48),
      )
    : 0;

  const cohortBadgeMarkup = cohortText
    ? `<g>
    <rect x="108" y="${badgeY}" width="${cohortBadgeWidth}" height="40" rx="20" fill="#f6ece2" stroke="#e8d2be" stroke-width="1" />
    <text x="128" y="${badgeY + 26}" font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif" font-size="18" font-weight="600" fill="#a4501f">${escapeXml(cohortText)}</text>
  </g>`
    : "";

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(`AIstudy 防踩坑避雷卡：${card.pitfallTitle}`)}">`,
    `  <rect x="0" y="0" width="${width}" height="${height}" fill="#faf9f5" />`,
    `  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="22" fill="#ffffff" stroke="#e8e5dc" stroke-width="2" />`,
    `  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="10" rx="5" fill="#047857" />`,
    `  <text x="108" y="128" font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif" font-size="22" font-weight="700" letter-spacing="0.5" fill="#1f1e1b">AIstudy</text>`,
    `  <text x="206" y="128" font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif" font-size="20" font-weight="600" fill="#5e5d59">· 防踩坑避雷卡</text>`,
    `  <rect x="108" y="150" width="${subjectWidth}" height="38" rx="19" fill="#f2f0e9" stroke="#e8e5dc" stroke-width="1" />`,
    `  <text x="132" y="175" font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif" font-size="18" font-weight="600" fill="#5e5d59">${escapeXml(card.subjectLabel)}</text>`,
    `  <text x="108" y="${titleStartY}" font-family="Georgia, Songti SC, Noto Serif SC, serif" font-size="38" font-weight="700" fill="#1f1e1b">${renderTspans(titleLines, 108, titleLineHeight)}</text>`,
    cohortBadgeMarkup,
    `  <rect x="108" y="${trapBoxY}" width="684" height="${trapBoxH}" rx="16" fill="#f6ece2" stroke="#e8e5dc" stroke-width="1.5" />`,
    `  <text x="136" y="${trapBoxY + 42}" font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif" font-size="18" font-weight="700" fill="#a4501f">容易踩的坑</text>`,
    `  <text x="136" y="${trapBoxY + 86}" font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif" font-size="23" font-weight="400" fill="#1f1e1b">${renderTspans(trapLines, 136, 38)}</text>`,
    `  <rect x="108" y="${ruleBoxY}" width="684" height="${ruleBoxH}" rx="16" fill="#e6f2eb" stroke="#d1e7db" stroke-width="1.5" />`,
    `  <text x="136" y="${ruleBoxY + 42}" font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif" font-size="18" font-weight="700" fill="#047857">避坑口诀</text>`,
    `  <text x="136" y="${ruleBoxY + 86}" font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif" font-size="23" font-weight="600" fill="#1f1e1b">${renderTspans(ruleLines, 136, 38)}</text>`,
    `  <line x1="108" y1="1028" x2="792" y2="1028" stroke="#e8e5dc" stroke-width="1.5" />`,
    `  <text x="108" y="1072" font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif" font-size="20" font-weight="600" fill="#1f1e1b">${sharePosterFooter(publicTryEnabled)}</text>`,
    `  <text x="108" y="1104" font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif" font-size="16" font-weight="400" fill="#6e6c65">匿名学习避雷卡 · 不含个人账号与成绩信息</text>`,
    `</svg>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function sharePosterFooter(publicTryEnabled: boolean): string {
  return publicTryEnabled ? "90 秒亲自排雷挑战 · /try" : "复习时再看一遍避坑口诀";
}
