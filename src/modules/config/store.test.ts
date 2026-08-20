import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decryptSecret: vi.fn(),
  encryptSecret: vi.fn(() => "encrypted-payload"),
  insert: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({
  encryptSecret: mocks.encryptSecret,
  decryptSecret: mocks.decryptSecret,
}));

vi.mock("@/db", () => ({
  getDb: () => ({
    insert: mocks.insert,
  }),
}));

import { getStoredGroupSnapshots, setStoredGroup } from "./store";

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

  it("reads groups once and isolates a corrupt encrypted row", async () => {
    const where = vi.fn(async () => [
      { key: "smtp", valueEncrypted: "smtp-payload", revision: 4 },
      { key: "turnstile", valueEncrypted: "corrupt-payload", revision: 7 },
    ]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    mocks.decryptSecret.mockImplementation((payload: string) => {
      if (payload === "corrupt-payload") throw new Error("decrypt failed");
      return JSON.stringify({ host: "smtp.example.test" });
    });

    const snapshots = await getStoredGroupSnapshots(["smtp", "turnstile", "missing", "smtp"], {
      select,
    } as never);

    expect(select).toHaveBeenCalledOnce();
    expect(snapshots.get("smtp")).toEqual({
      ok: true,
      snapshot: { value: { host: "smtp.example.test" }, revision: 4 },
    });
    expect(snapshots.get("turnstile")).toMatchObject({
      ok: false,
      error: expect.objectContaining({ message: "decrypt failed" }),
    });
    expect(snapshots.get("missing")).toEqual({
      ok: true,
      snapshot: { value: null, revision: 0 },
    });
    expect(snapshots).toHaveLength(3);
  });
});
