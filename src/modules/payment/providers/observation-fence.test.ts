import { describe, expect, it } from "vitest";

import { providerObservationFence } from ".";

describe("providerObservationFence", () => {
  it("normalizes a provider timestamp to the end of its represented second", () => {
    expect(providerObservationFence(new Date("2026-01-20T00:00:00.000Z"))).toEqual(
      new Date("2026-01-20T00:00:00.999Z"),
    );
    expect(providerObservationFence(new Date("2026-01-20T00:00:00.321Z"))).toEqual(
      new Date("2026-01-20T00:00:00.999Z"),
    );
  });

  it("keeps the fence in the provider clock domain and before the next second", () => {
    const observedAt = new Date("2026-01-20T00:00:00.000Z");
    const fence = providerObservationFence(observedAt);

    expect(fence.getTime()).toBe(observedAt.getTime() + 999);
    expect(fence.getTime()).toBeLessThan(new Date("2026-01-20T00:00:01.000Z").getTime());
  });
});
