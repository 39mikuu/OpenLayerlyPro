import { describe, expect, it } from "vitest";

import { parseSingleRange } from "./range";

describe("parseSingleRange", () => {
  it("returns null when no Range header is present", () => {
    expect(parseSingleRange(null, 1000)).toBeNull();
  });

  it.each([
    ["bytes=0-1023", 2048, { start: 0, end: 1023 }],
    ["bytes=100-", 1000, { start: 100, end: 999 }],
    ["bytes=-500", 1000, { start: 500, end: 999 }],
    ["bytes=900-9999", 1000, { start: 900, end: 999 }],
    ["bytes=-5000", 1000, { start: 0, end: 999 }],
    ["bytes=0-0", 1, { start: 0, end: 0 }],
    [
      `bytes=${Number.MAX_SAFE_INTEGER}-${Number.MAX_SAFE_INTEGER}`,
      Number.MAX_SAFE_INTEGER,
      "unsatisfiable",
    ],
  ] as const)("parses %s", (header, size, expected) => {
    expect(parseSingleRange(header, size)).toEqual(expected);
  });

  it.each([
    "items=0-10",
    "bytes=0-1,2-3",
    "bytes=",
    "bytes=-",
    "bytes=abc-def",
    "bytes=10-1",
    "bytes =0-10",
    "bytes= 0-10",
    " bytes=0-10",
    "bytes=0-10 ",
    "bytes=1.5-2",
    "bytes=+1-2",
    "bytes=-1--2",
    "bytes=0 -10",
    "bytes=0000000000000000000000000000000000001-2",
    `bytes=${Number.MAX_SAFE_INTEGER + 1}-`,
    "bytes=999999999999999999999999999999999999999999-",
  ])("ignores malformed or unsupported range %s", (header) => {
    expect(parseSingleRange(header, 1000)).toBeNull();
  });

  it.each([
    ["bytes=1000-", 1000],
    ["bytes=1000-2000", 1000],
    ["bytes=-0", 1000],
    ["bytes=0-1", 0],
    ["bytes=0-", 0],
    ["bytes=-1", 0],
  ] as const)("returns unsatisfiable for %s with size %s", (header, size) => {
    expect(parseSingleRange(header, size)).toBe("unsatisfiable");
  });

  it("ignores invalid file sizes", () => {
    expect(parseSingleRange("bytes=0-1", -1)).toBeNull();
    expect(parseSingleRange("bytes=0-1", Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseSingleRange("bytes=0-1", Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});
