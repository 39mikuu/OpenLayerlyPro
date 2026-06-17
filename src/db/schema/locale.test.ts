import { describe, expect, it } from "vitest";

import { users } from "./index";

describe("users.locale", () => {
  it("supports Japanese while keeping Chinese as the default", () => {
    expect(users.locale.enumValues).toEqual(["zh", "en", "ja"]);
    expect(users.locale.default).toBe("zh");
    expect(users.locale.notNull).toBe(true);
  });
});
