import { validateCartridgeLite } from "@aistudy/contracts/cartridge-lite";

export type CartridgeLiteExecution = {
  status: "graded";
  earnedPoints: number;
  possiblePoints: number;
  items: Array<{ id: string; criterion: string; correct: boolean; earnedPoints: number; possiblePoints: number }>;
} | { status: "unsupported_level" | "unavailable" | "invalid_cartridge" | "invalid_answers" };

export function executeCartridgeLite(input: unknown, replies: unknown): CartridgeLiteExecution {
  const candidate = validateCartridgeLite(input);
  if (!candidate.ok) return { status: candidate.code };
  if (!replies || typeof replies !== "object" || Array.isArray(replies)) return { status: "invalid_answers" };
  const answers = new Map(Object.entries(replies));
  const itemIds = new Set(candidate.cartridge.items.map(item => item.id));
  if ([...answers].some(([id, value]) => !itemIds.has(id) || typeof value !== "string")) return { status: "invalid_answers" };
  const items = candidate.cartridge.items.map(item => {
    const answer = answers.get(item.id) as string | undefined;
    const correct = answer !== undefined && (item.kind === "single_choice"
      ? answer === item.answerId
      : item.accepted.some(expected => item.comparison === "trim" ? answer.trim() === expected.trim() : answer === expected));
    return { id: item.id, criterion: item.criterion.label, correct,
      earnedPoints: correct ? item.criterion.points : 0, possiblePoints: item.criterion.points };
  });
  return { status: "graded", items, earnedPoints: items.reduce((total, item) => total + item.earnedPoints, 0),
    possiblePoints: items.reduce((total, item) => total + item.possiblePoints, 0) };
}
