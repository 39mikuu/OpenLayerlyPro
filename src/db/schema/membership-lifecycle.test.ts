import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { auditEvents, memberships } from "./index";

describe("membership lifecycle schema", () => {
  it("stores explicit lifecycle state and optimistic-lock version", () => {
    expect(memberships.status.enumValues).toEqual(["active", "suspended", "revoked"]);
    expect(memberships.status.default).toBe("active");
    expect(memberships.status.notNull).toBe(true);
    expect(memberships.version.default).toBe(0);
    expect(memberships.version.notNull).toBe(true);
  });

  it("indexes entity timelines and causal audit lookups", () => {
    const indexes = getTableConfig(auditEvents).indexes.map((index) => index.config.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "audit_events_entity_idx",
        "audit_events_correlation_idx",
        "audit_events_causation_idx",
      ]),
    );
  });
});
