import { describe, expect, it } from "vitest";

import {
  APP_STORAGE_OBJECT_PREFIXES,
  parseS3EnumerationPrefixes,
  validateS3EnumerationPrefix,
} from "./s3EnumerationPrefixes";

describe("validateS3EnumerationPrefix", () => {
  it("accepts controlled namespace prefixes", () => {
    for (const prefix of APP_STORAGE_OBJECT_PREFIXES) {
      expect(() => validateS3EnumerationPrefix(prefix)).not.toThrow();
    }
  });

  it("rejects empty, relative, and traversal prefixes", () => {
    expect(() => validateS3EnumerationPrefix("")).toThrow(/empty/i);
    expect(() => validateS3EnumerationPrefix("content")).toThrow(/end with/i);
    expect(() => validateS3EnumerationPrefix("/content/")).toThrow(/start with/i);
    expect(() => validateS3EnumerationPrefix("content/../")).toThrow(/\.\./);
  });
});

describe("parseS3EnumerationPrefixes", () => {
  it("defaults to all application namespaces", () => {
    expect(parseS3EnumerationPrefixes()).toEqual([...APP_STORAGE_OBJECT_PREFIXES]);
  });

  it("parses comma-separated overrides", () => {
    expect(parseS3EnumerationPrefixes("content/,legacy/")).toEqual(["content/", "legacy/"]);
  });
});
