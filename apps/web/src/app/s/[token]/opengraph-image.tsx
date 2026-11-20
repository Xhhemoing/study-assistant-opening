import { ImageResponse } from "next/og";
import { toDisplayShareCard } from "../../../features/opening/share/schema";
import { verifyPitfallShareToken } from "../../../features/opening/share/token-codec";

export const runtime = "nodejs";
export const alt = "AIstudy 防踩坑避雷卡";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type OpenGraphImageProps = {
  params: Promise<{ token: string }>;
};

function clipText(value: string, maxChars: number): string {
  const chars = [...value];
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

export default async function OpenGraphImage({ params }: OpenGraphImageProps) {
  const { token } = await params;
  const verified = verifyPitfallShareToken(token);

  if (!verified.ok) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: "56px 64px",
            backgroundColor: "#faf9f5",
            color: "#1f1e1b",
            fontFamily: "sans-serif",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ fontSize: "28px", fontWeight: 700 }}>AIstudy</span>
              <span style={{ fontSize: "22px", color: "#5e5d59" }}>· 防踩坑避雷卡</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <div style={{ fontSize: "52px", fontWeight: 700, lineHeight: 1.25 }}>
              把容易做错的题，变成清晰的避坑口诀
            </div>
            <div style={{ fontSize: "26px", color: "#5e5d59", lineHeight: 1.5 }}>
              匿名学习卡片分享 · 欢迎前往 AIstudy 体验 90 秒亲自排雷挑战
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderTop: "2px solid #e8e5dc",
              paddingTop: "24px",
              fontSize: "22px",
              color: "#6e6c65",
            }}
          >
            <span>AIstudy 学习助手</span>
            <span style={{ color: "#047857", fontWeight: 600 }}>90 秒亲自排雷挑战 · /try</span>
          </div>
        </div>
      ),
      { ...size },
    );
  }

  const card = toDisplayShareCard(verified.payload);
  const cohortBadge =
    card.cohortTrapRate !== null
      ? `约 ${card.cohortTrapRate}% 同学曾在此踩坑 · ${card.cohortSampleSize} 人样本`
      : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          padding: "36px",
          backgroundColor: "#faf9f5",
          color: "#1f1e1b",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            backgroundColor: "#ffffff",
            border: "2px solid #e8e5dc",
            borderTop: "10px solid #047857",
            borderRadius: "20px",
            padding: "36px 44px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "16px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <span style={{ fontSize: "24px", fontWeight: 700 }}>AIstudy</span>
                <span style={{ fontSize: "20px", color: "#5e5d59" }}>· 防踩坑避雷卡</span>
              </div>
              <div
                style={{
                  display: "flex",
                  padding: "6px 18px",
                  borderRadius: "999px",
                  backgroundColor: "#f2f0e9",
                  border: "1px solid #e8e5dc",
                  fontSize: "19px",
                  color: "#5e5d59",
                  fontWeight: 600,
                }}
              >
                {clipText(card.subjectLabel, 24)}
              </div>
            </div>

            <div
              style={{
                fontSize: "40px",
                fontWeight: 700,
                lineHeight: 1.25,
                color: "#1f1e1b",
              }}
            >
              {clipText(card.pitfallTitle, 46)}
            </div>

            {cohortBadge ? (
              <div style={{ display: "flex" }}>
                <div
                  style={{
                    display: "flex",
                    padding: "6px 16px",
                    borderRadius: "999px",
                    backgroundColor: "#f6ece2",
                    color: "#a4501f",
                    fontSize: "18px",
                    fontWeight: 600,
                  }}
                >
                  {cohortBadge}
                </div>
              </div>
            ) : null}
          </div>

          <div style={{ display: "flex", gap: "20px", width: "100%" }}>
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                padding: "20px 24px",
                borderRadius: "14px",
                backgroundColor: "#f6ece2",
                border: "1px solid #e8e5dc",
              }}
            >
              <div style={{ fontSize: "18px", fontWeight: 700, color: "#a4501f" }}>
                容易踩的坑
              </div>
              <div style={{ fontSize: "21px", lineHeight: 1.5, color: "#1f1e1b" }}>
                {clipText(card.trapSummary, 84)}
              </div>
            </div>

            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                padding: "20px 24px",
                borderRadius: "14px",
                backgroundColor: "#e6f2eb",
                border: "1px solid #d1e7db",
              }}
            >
              <div style={{ fontSize: "18px", fontWeight: 700, color: "#047857" }}>
                避坑口诀
              </div>
              <div style={{ fontSize: "21px", lineHeight: 1.5, fontWeight: 600, color: "#1f1e1b" }}>
                {clipText(card.takeawayRule, 84)}
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderTop: "1px solid #e8e5dc",
              paddingTop: "16px",
              fontSize: "18px",
              color: "#6e6c65",
            }}
          >
            <span>匿名学习避雷卡 · 不含个人账号与成绩信息</span>
            <span style={{ color: "#1f1e1b", fontWeight: 600 }}>90 秒亲自排雷挑战 · /try</span>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
