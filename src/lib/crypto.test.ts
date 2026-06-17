import { afterEach, describe, expect, it, vi } from "vitest";

import { getConfigEncryptionKey } from "@/modules/security/config-key";

import { decryptSecret, encryptSecret } from "./crypto";

vi.mock("@/modules/security/config-key", () => ({
  getConfigEncryptionKey: vi.fn(),
}));

const mockedGetKey = vi.mocked(getConfigEncryptionKey);

describe("encryptSecret / decryptSecret", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("加解密往返还原明文", () => {
    mockedGetKey.mockReturnValue("test-root-key");
    const cipher = encryptSecret("hello 世界");
    expect(decryptSecret(cipher)).toBe("hello 世界");
  });

  it("相同明文每次密文不同（随机 iv）", () => {
    mockedGetKey.mockReturnValue("test-root-key");
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("密文被篡改时解密抛错", () => {
    mockedGetKey.mockReturnValue("test-root-key");
    const cipher = encryptSecret("payload");
    const parts = cipher.split(":");
    const tampered = Buffer.from(parts[3], "base64");
    tampered[0] ^= 0xff;
    parts[3] = tampered.toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("密钥不一致时解密抛错", () => {
    mockedGetKey.mockReturnValue("key-a");
    const cipher = encryptSecret("payload");
    mockedGetKey.mockReturnValue("key-b");
    expect(() => decryptSecret(cipher)).toThrow();
  });

  it("格式非法时解密抛错", () => {
    mockedGetKey.mockReturnValue("test-root-key");
    expect(() => decryptSecret("not-a-valid-cipher")).toThrow("配置密文格式无效");
  });

  it("未配置密钥时抛错", () => {
    mockedGetKey.mockReturnValue(null);
    expect(() => encryptSecret("x")).toThrow(/配置加密密钥未配置/);
  });
});
