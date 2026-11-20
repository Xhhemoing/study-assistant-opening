import { challenges, type TryReceipt } from "./challenges";

export type TrySearchParams = Record<string, string | string[] | undefined>;
export type TryContinuation = Pick<TryReceipt, "challenge" | "step">;

export function parseTryContinuation(params: TrySearchParams): TryContinuation | null {
  if (params.from !== "try") return null;
  const question = challenges.find(item => item.id === params.challenge);
  if (!question) return null;
  const step = question.steps.findIndex((_, index) => String(index) === params.step);
  return step < 0 ? null : { challenge: question.id, step };
}

function tryQuery({ challenge, step }: TryContinuation) {
  return new URLSearchParams({ from: "try", challenge, step: String(step) });
}

export function tryAuthHref(entry: "/login" | "/register", context: TryContinuation | null) {
  return context ? `${entry}?${tryQuery(context)}` : entry;
}

export function continuedTryHref(context: TryContinuation, mode: "login" | "register") {
  const query = tryQuery(context);
  query.set("continued", mode);
  return `/try?${query}`;
}
