import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  encryptSecret: vi.fn(() => "encrypted-payload"),
  insert: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({
  encryptSecret: mocks.encryptSecret,
  decryptSecret: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDb: () => ({
    insert: mocks.insert,
  }),
}));

import { setStoredGroup } from "./store";

describe("encrypted config store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const returning = vi.fn(async () => [{ revision: 1 }]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    mocks.insert.mockReturnValue({
      values: vi.fn(() => ({
        onConflictDoNothing,
      })),
    });
  });

  it("encrypts a translation api key before writing app_settings", async () => {
    await setStoredGroup("translation", {
      enabled: true,
      apiKey: "plain-secret",
    });

    expect(mocks.encryptSecret).toHaveBeenCalledWith(
      JSON.stringify({ enabled: true, apiKey: "plain-secret" }),
    );
    const values = mocks.insert.mock.results[0]?.value.values;
    expect(values).toHaveBeenCalledWith({
      key: "translation",
      valueEncrypted: "encrypted-payload",
      revision: 1,
    });
    expect(JSON.stringify(values.mock.calls)).not.toContain("plain-secret");
  });
});
