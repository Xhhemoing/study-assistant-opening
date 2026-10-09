/**
 * Unified local day-boundary (TZ01 / research §5.3).
 * Input: calendar localDate + IANA timeZone → half-open [dayStart, nextDayStart).
 * Storage stays absolute; display/timetable expansion use workspace TZ.
 */

export type LocalDayBounds = {
  /** Inclusive start of the local calendar day (absolute instant). */
  dayStart: Date;
  /** Exclusive end = start of the next local calendar day. */
  nextDayStart: Date;
};

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function partsAt(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce<Record<string, string>>((all, part) => {
    all[part.type] = part.value;
    return all;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Resolve a wall-clock `YYYY-MM-DDTHH:mm` in an IANA zone to an absolute Date. */
export function zonedLocalInstant(local: string, timeZone: string): Date {
  const wall = Date.parse(`${local}Z`);
  if (!Number.isFinite(wall)) throw new RangeError(`invalid local date/time: ${local}`);
  const offsets = new Set<number>();
  for (let hour = -48; hour <= 48; hour += 6) {
    const sample = new Date(wall + hour * 3_600_000);
    const displayed = partsAt(sample, timeZone);
    offsets.add(Date.parse(`${displayed}Z`) - sample.getTime());
  }
  const matches = [...offsets]
    .map((offset) => new Date(wall - offset))
    .filter((date) => partsAt(date, timeZone) === local);
  if (matches.length === 0) {
    throw new RangeError(`nonexistent DST or invalid local time: ${local} in ${timeZone}`);
  }
  if (matches.length > 1) {
    throw new RangeError(`ambiguous DST local time: ${local} in ${timeZone}`);
  }
  const first = matches[0];
  if (!first) throw new RangeError(`no resolution for local time: ${local} in ${timeZone}`);
  return first;
}

function assertValidTimeZone(timeZone: string): void {
  if (typeof timeZone !== "string" || timeZone.length === 0) {
    throw new RangeError(`invalid timeZone: ${String(timeZone)}`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new RangeError(`invalid timeZone: ${timeZone}`);
  }
}

/**
 * Reject non-YYYY-MM-DD and illegal calendar dates (e.g. 2026-02-30).
 * JS Date.parse would roll Feb 30 forward — that must hard-error here.
 */
export function assertValidLocalDate(localDate: string): void {
  if (!LOCAL_DATE_RE.test(localDate)) {
    throw new RangeError(`invalid localDate: ${localDate}`);
  }
  const [ys, ms, ds] = localDate.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    !Number.isFinite(probe.getTime()) ||
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    throw new RangeError(`illegal localDate: ${localDate}`);
  }
}

function addCalendarDays(localDate: string, days: number): string {
  assertValidLocalDate(localDate);
  const ms = Date.parse(`${localDate}T00:00:00Z`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Half-open local day bounds in absolute time.
 * Instant `t` is on `localDate` iff dayStart <= t < nextDayStart.
 */
export function resolveLocalDayBounds(localDate: string, timeZone: string): LocalDayBounds {
  assertValidLocalDate(localDate);
  assertValidTimeZone(timeZone);
  const next = addCalendarDays(localDate, 1);
  const dayStart = zonedLocalInstant(`${localDate}T00:00`, timeZone);
  const nextDayStart = zonedLocalInstant(`${next}T00:00`, timeZone);
  if (!(nextDayStart.getTime() > dayStart.getTime())) {
    throw new RangeError(`degenerate day bounds for ${localDate} in ${timeZone}`);
  }
  return { dayStart, nextDayStart };
}

/** True when absolute instant falls in the half-open local day. */
export function isInstantOnLocalDay(
  instant: Date | string | number,
  localDate: string,
  timeZone: string,
): boolean {
  const { dayStart, nextDayStart } = resolveLocalDayBounds(localDate, timeZone);
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(t)) throw new RangeError("invalid instant");
  return t >= dayStart.getTime() && t < nextDayStart.getTime();
}
