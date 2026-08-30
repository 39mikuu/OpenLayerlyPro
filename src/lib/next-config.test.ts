import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

describe("Next.js response metadata", () => {
  it("does not advertise the framework through X-Powered-By", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
