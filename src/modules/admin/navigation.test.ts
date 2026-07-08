import { describe, expect, it } from "vitest";

import { adminNavGroups, matchAdminNavItem } from "./navigation";

describe("admin navigation matching", () => {
  it("matches /admin only exactly, including a trailing slash", () => {
    expect(matchAdminNavItem("/admin")?.href).toBe("/admin");
    expect(matchAdminNavItem("/admin/")?.href).toBe("/admin");
    expect(matchAdminNavItem("/admin?from=test")?.href).toBe("/admin");
    expect(matchAdminNavItem("/admin/account")?.href).not.toBe("/admin");
  });

  it("matches nested routes by full path segment boundaries", () => {
    expect(matchAdminNavItem("/admin/posts/new")?.href).toBe("/admin/posts");
    expect(matchAdminNavItem("/admin/posts/11111111-1111-4111-8111-111111111111")?.href).toBe(
      "/admin/posts",
    );
    expect(matchAdminNavItem("/admin/posts/")?.href).toBe("/admin/posts");
    expect(matchAdminNavItem("/admin/posts-legacy")).toBeNull();
    expect(matchAdminNavItem("/admin/payments-legacy/reviews")).toBeNull();
  });

  it("uses the longest matching route when routes share a prefix", () => {
    expect(matchAdminNavItem("/admin/payments/reviews")?.href).toBe("/admin/payments/reviews");
    expect(matchAdminNavItem("/admin/payments/reviews/history")?.href).toBe(
      "/admin/payments/reviews",
    );
    expect(matchAdminNavItem("/admin/payments/methods")?.href).toBe("/admin/payments/methods");
  });

  it("keeps groups separate from link items", () => {
    expect(adminNavGroups.some((group) => group.items.length === 0)).toBe(false);
    expect(adminNavGroups.map((group) => group.key)).toEqual([
      "overview",
      "content",
      "members",
      "payments",
      "operations",
      "site",
      "system",
    ]);
  });
});
