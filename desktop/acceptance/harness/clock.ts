/**
 * Fixed UTC clock helpers. Acceptance code never reads the system clock.
 */

export interface MonthWindow {
  /** Inclusive UTC start, ISO string. */
  start: string;
  /** Exclusive UTC end, ISO string. */
  end: string;
  year: number;
  month: number;
}

export class FixedClock {
  readonly iso: string;
  readonly millis: number;

  constructor(iso: string) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
      throw new Error(`invalid fixed clock: ${iso}`);
    }
    this.iso = new Date(ms).toISOString();
    this.millis = ms;
  }

  nowUtc(): Date {
    return new Date(this.millis);
  }
}

export function monthWindowUtc(year: number, month: number): MonthWindow {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`invalid month window ${year}-${month}`);
  }
  const start = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  const end = Date.UTC(year, month, 1, 0, 0, 0, 0);
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    year,
    month,
  };
}

/** Natural months, including the month containing the frozen clock. */
export function recentMonthWindows(clockUtc: string, months: number): MonthWindow[] {
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new Error(`invalid months value: ${months}`);
  }
  const clock = new FixedClock(clockUtc);
  const date = clock.nowUtc();
  const windows: MonthWindow[] = [];
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const point = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - offset, 1));
    windows.push(monthWindowUtc(point.getUTCFullYear(), point.getUTCMonth() + 1));
  }
  return windows;
}

export function rangeWindows(range: { kind: string; months?: number; year?: number; month?: number }, clockUtc: string): MonthWindow[] {
  if (range.kind === "month") {
    return [monthWindowUtc(Number(range.year), Number(range.month))];
  }
  if (range.kind === "months") {
    return recentMonthWindows(clockUtc, Number(range.months));
  }
  return [];
}
