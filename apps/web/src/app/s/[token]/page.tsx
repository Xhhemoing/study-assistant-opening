import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { toDisplayShareCard } from "../../../features/opening/share/schema";
import { PitfallShareCard } from "../../../features/opening/share/share-card";
import { verifyPitfallShareToken } from "../../../features/opening/share/token-codec";

export const dynamic = "force-dynamic";

type SharePageProps = {
  params: Promise<{ token: string }>;
};

export async function generateMetadata({ params }: SharePageProps): Promise<Metadata> {
  const { token } = await params;
  const verified = verifyPitfallShareToken(token);
  if (!verified.ok) {
    return {
      title: "防踩坑避雷卡 | AIstudy",
      description: "AIstudy 匿名学习避雷卡",
      robots: { index: false, follow: false },
    };
  }

  const card = toDisplayShareCard(verified.payload);
  return {
    title: `${card.pitfallTitle} · 防踩坑避雷卡 | AIstudy`,
    description: card.trapSummary,
    robots: { index: false, follow: false },
    openGraph: {
      title: `${card.pitfallTitle} · 防踩坑避雷卡`,
      description: card.trapSummary,
      type: "article",
    },
  };
}

export default async function SharePitfallPage({ params }: SharePageProps) {
  const { token } = await params;
  const verified = verifyPitfallShareToken(token);

  if (!verified.ok) {
    notFound();
  }

  const card = toDisplayShareCard(verified.payload);
  return <PitfallShareCard card={card} />;
}
