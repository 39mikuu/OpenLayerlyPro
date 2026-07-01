export const ADMIN_LIST_PAGE_SIZE = 50;
export const ADMIN_LIST_MAX_PAGE_SIZE = 100;

export type AdminListCursor = {
  timestamp: string;
  id: string;
};

export type AdminListPage<T> = {
  items: T[];
  nextCursor: string | null;
};

const PRECISE_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function maxDayOfMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function isPreciseUtcTimestamp(value: string): boolean {
  const match = PRECISE_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  return (
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= maxDayOfMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

export function normalizeAdminPageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return ADMIN_LIST_PAGE_SIZE;
  return Math.max(1, Math.min(Math.trunc(value!), ADMIN_LIST_MAX_PAGE_SIZE));
}

export function parseAdminPageSize(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return normalizeAdminPageSize(Number(value));
}

export function encodeAdminListCursor(cursor: AdminListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeAdminListCursor(value: string | null | undefined): AdminListCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<AdminListCursor>;
    if (
      typeof parsed.timestamp !== "string" ||
      !isPreciseUtcTimestamp(parsed.timestamp) ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      return null;
    }
    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch {
    return null;
  }
}
