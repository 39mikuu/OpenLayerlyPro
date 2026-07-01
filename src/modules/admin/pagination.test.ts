import { describe, expect, it } from "vitest";

import {
  ADMIN_LIST_MAX_PAGE_SIZE,
  ADMIN_LIST_PAGE_SIZE,
  decodeAdminListCursor,
  encodeAdminListCursor,
  normalizeAdminPageSize,
  parseAdminPageSize,
} from "./pagination";

describe("admin list pagination", () => {
  const cursor = {
    timestamp: "2026-07-02T01:02:03.000004Z",
    id: "11111111-1111-4111-8111-111111111111",
  };

  it("round-trips an opaque timestamp and UUID cursor", () => {
    expect(decodeAdminListCursor(encodeAdminListCursor(cursor))).toEqual(cursor);
  });

  it.each([
    "",
    "invalid",
    encodeAdminListCursor({ ...cursor, timestamp: "2026-02-30T01:02:03.000004Z" }),
    encodeAdminListCursor({ ...cursor, id: "not-a-uuid" }),
  ])("rejects invalid cursor %s", (value) => {
    expect(decodeAdminListCursor(value)).toBeNull();
  });

  it("defaults and bounds page sizes", () => {
    expect(normalizeAdminPageSize(undefined)).toBe(ADMIN_LIST_PAGE_SIZE);
    expect(normalizeAdminPageSize(Number.NaN)).toBe(ADMIN_LIST_PAGE_SIZE);
    expect(normalizeAdminPageSize(0)).toBe(1);
    expect(normalizeAdminPageSize(2.9)).toBe(2);
    expect(normalizeAdminPageSize(ADMIN_LIST_MAX_PAGE_SIZE + 1)).toBe(ADMIN_LIST_MAX_PAGE_SIZE);
    expect(parseAdminPageSize(null)).toBeUndefined();
    expect(parseAdminPageSize("-1")).toBeUndefined();
    expect(parseAdminPageSize("2.5")).toBeUndefined();
    expect(parseAdminPageSize("25")).toBe(25);
  });
});
