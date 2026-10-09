import type { ActionCandidate } from "@aistudy/contracts";
import { resolveLocalDayBounds } from "./local-day-bounds";

/** Authorized import + course chunk text available to the extract worker. */
export type ExtractableImportChunk = {
  sourceId: string;
  receiptId: string;
  text: string;
  /** Notification/send time from the source — never the sync clock. */
  sentAt: string | null;
  /** Forwarded mail / mirrored notice without a reliable original date. */
  isForward?: boolean;
  /** Optional stable channel tag for dedupe keys (mail|dingtalk|manual). */
  channel?: string;
};

export type ExtractStudyActionsOptions = {
  timeZone: string;
  /** Stable id factory for tests. */
  createId?: () => string;
};

export type DueResolution = {
  dueAt: string | null;
  needsConfirmation: boolean;
  confirmationReason: string | null;
};


function newActionId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = character === "x" ? value : (value & 3) | 8;
    return nibble.toString(16);
  });
}

const RELATIVE_WEEK =
  /下周([一二三四五六日天])?|next\s+week(?:\s+on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))?/i;
const RELATIVE_DAY = /明天|后天|今晚|today|tomorrow/i;
const ABSOLUTE_ISO = /\b(20\d{2})-(\d{2})-(\d{2})\b/;
const ABSOLUTE_CN = /(20\d{2})?年?(\d{1,2})月(\d{1,2})日/;
const HOMEWORK =
  /(作业|交作业|homework|assignment|ddl|deadline|截止|提交)/i;
const EXAM = /(考试|期末|期中|exam|quiz|测验)/i;

function localDateParts(instant: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Last inclusive instant of a local calendar day (TZ01: nextDayStart - 1ms). */
export function endOfLocalDayIso(year: number, month: number, day: number, timeZone: string): string {
  const localDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const { nextDayStart } = resolveLocalDayBounds(localDate, timeZone);
  return new Date(nextDayStart.getTime() - 1).toISOString();
}

/**
 * Resolve a due instant from notice text.
 * Relative phrases without sentAt → dueAt null + needsConfirmation.
 * Forwards always need confirmation. Sync clock must not be passed as sentAt.
 */
export function resolveCandidateDueAt(input: {
  text: string;
  sentAt: string | null;
  timeZone: string;
  isForward?: boolean;
}): DueResolution {
  const text = input.text;
  const isForward = Boolean(input.isForward);
  const hasRelative = RELATIVE_WEEK.test(text) || RELATIVE_DAY.test(text);

  if (isForward) {
    return {
      dueAt: null,
      needsConfirmation: true,
      confirmationReason: "forwarded_notice",
    };
  }

  const iso = text.match(ABSOLUTE_ISO);
  if (iso) {
    const dueAt = endOfLocalDayIso(Number(iso[1]), Number(iso[2]), Number(iso[3]), input.timeZone);
    return { dueAt, needsConfirmation: false, confirmationReason: null };
  }

  const cn = text.match(ABSOLUTE_CN);
  if (cn) {
    const year =
      cn[1] != null
        ? Number(cn[1])
        : input.sentAt
          ? localDateParts(new Date(input.sentAt), input.timeZone).y
          : null;
    if (year == null) {
      return {
        dueAt: null,
        needsConfirmation: true,
        confirmationReason: "absolute_date_missing_year_anchor",
      };
    }
    const dueAt = endOfLocalDayIso(year, Number(cn[2]), Number(cn[3]), input.timeZone);
    return { dueAt, needsConfirmation: false, confirmationReason: null };
  }

  if (hasRelative && !input.sentAt) {
    return {
      dueAt: null,
      needsConfirmation: true,
      confirmationReason: "relative_date_missing_sent_at",
    };
  }

  if (hasRelative && input.sentAt) {
    // Anchor relative phrases to the notice sentAt — never the sync clock.
    // Thin slice: "下周" without weekday → still needsConfirmation (ambiguous).
    if (/下周(?![一二三四五六日天])|next\s+week(?!\s+on)/i.test(text)) {
      return {
        dueAt: null,
        needsConfirmation: true,
        confirmationReason: "relative_week_missing_weekday",
      };
    }
    return {
      dueAt: null,
      needsConfirmation: true,
      confirmationReason: "relative_date_needs_confirmation",
    };
  }

  if (HOMEWORK.test(text) || EXAM.test(text)) {
    return {
      dueAt: null,
      needsConfirmation: true,
      confirmationReason: "deadline_text_without_parseable_date",
    };
  }

  return { dueAt: null, needsConfirmation: false, confirmationReason: null };
}

function titleFromText(text: string): string | null {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  if (!line) return null;
  if (!(HOMEWORK.test(line) || EXAM.test(line) || HOMEWORK.test(text) || EXAM.test(text))) {
    return null;
  }
  return line.slice(0, 500);
}

function kindPriority(text: string): { minutes: number; priority: number; kind: string } {
  if (EXAM.test(text)) return { minutes: 90, priority: 3, kind: "exam" };
  if (HOMEWORK.test(text)) return { minutes: 30, priority: 2, kind: "homework" };
  return { minutes: 30, priority: 1, kind: "activity" };
}

/**
 * Extract pending ActionCandidates from authorized import chunks.
 * Never emits accepted/rejected — auto-organize ≠ auto-commit.
 */
export function extractStudyActionCandidates(
  chunks: readonly ExtractableImportChunk[],
  options: ExtractStudyActionsOptions,
): ActionCandidate[] {
  const createId = options.createId ?? newActionId;
  const out: ActionCandidate[] = [];
  for (const chunk of chunks) {
    const title = titleFromText(chunk.text);
    if (!title) continue;
    const meta = kindPriority(chunk.text);
    const due = resolveCandidateDueAt({
      text: chunk.text,
      sentAt: chunk.sentAt,
      timeZone: options.timeZone,
      isForward: chunk.isForward,
    });
    // Skip pure chatter with no study signal and no confirmation need.
    if (!due.needsConfirmation && due.dueAt == null && meta.kind === "activity") {
      if (!HOMEWORK.test(chunk.text) && !EXAM.test(chunk.text)) continue;
    }
    const channel = chunk.channel ?? "import";
    const dedupeKey = `${channel}:${chunk.receiptId}:${meta.kind}:${title}`.slice(0, 240);
    out.push({
      id: createId(),
      dedupeKey,
      title,
      minutes: meta.minutes,
      dueAt: due.dueAt,
      priority: meta.priority,
      sourceIds: [chunk.sourceId],
      status: "pending",
      needsConfirmation: due.needsConfirmation || due.dueAt == null,
    });
  }
  return out;
}
