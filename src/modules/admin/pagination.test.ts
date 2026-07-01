import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import {
  ADMIN_LIST_CURSOR_MAX_LENGTH,
  ADMIN_LIST_MAX_PAGE_SIZE,
  ADMIN_LIST_PAGE_SIZE,
  decodeAdminListCursor,
  encodeAdminListCursor,
  normalizeAdminPageSize,
  parseAdminPageSize,
} from "./pagination";

const cursor = {
  version: 1 as const,
  scope: "memberships" as const,
  timestamp: "2026-07-02T01:02:03.000004Z",
  id: "11111111-1111-4111-8111-111111111111",
};

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function expectInvalidCursor(value: string, scope: Parameters<typeof decodeAdminListCursor>[1]) {
  try {
    decodeAdminListCursor(value, scope);
    throw new Error("expected invalidCursor");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "invalidCursor" });
  }
}

describe("admin list cursor contract", () => {
  it("round-trips a versioned, scoped, opaque cursor", () => {
    expect(decodeAdminListCursor(encodeAdminListCursor(cursor), "memberships")).toEqual(cursor);
  });

  it.each([null, undefined, ""])("treats a missing cursor as page one", (value) => {
    expect(decodeAdminListCursor(value, "memberships")).toBeNull();
  });

  it.each([
    ["invalid base64url", "*"],
    ["invalid JSON", Buffer.from("{", "utf8").toString("base64url")],
    ["null", encodeJson(null)],
    ["array", encodeJson([cursor])],
    ["missing field", encodeJson({ ...cursor, id: undefined })],
    ["extra field", encodeJson({ ...cursor, extra: true })],
    ["wrong version", encodeJson({ ...cursor, version: 2 })],
    ["unknown scope", encodeJson({ ...cursor, scope: "payments:all" })],
    ["invalid timestamp", encodeJson({ ...cursor, timestamp: "2026-02-30T01:02:03.000004Z" })],
    ["non-microsecond UTC timestamp", encodeJson({ ...cursor, timestamp: "2026-07-02T01:02:03Z" })],
    ["invalid UUID", encodeJson({ ...cursor, id: "not-a-uuid" })],
    ["oversized", "A".repeat(ADMIN_LIST_CURSOR_MAX_LENGTH + 1)],
  ])("rejects %s", (_label, value) => {
    expectInvalidCursor(value, "memberships");
  });

  it("rejects a valid cursor used by a different query scope", () => {
    expectInvalidCursor(encodeAdminListCursor(cursor), "payments:pending");
  });
});

describe("admin list page size", () => {
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
