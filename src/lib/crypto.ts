import bcrypt from "bcryptjs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "crypto";

import { getEnv } from "@/lib/env";
import { getConfigEncryptionKey } from "@/modules/security/config-key";

export const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 用 SESSION_SECRET 做 HMAC 的哈希，用于 session token 和登录验证码入库。
 * 即使数据库内容泄露，没有 SECRET 也无法伪造 token 或离线爆破验证码。
 */
export function hmacSha256(input: string): string {
  return createHmac("sha256", getEnv().SESSION_SECRET).update(input).digest("hex");
}

export function hmacSha256WithPurpose(purpose: string, input: string): string {
  return createHmac("sha256", getEnv().SESSION_SECRET)
    .update(purpose)
    .update("\0")
    .update(input)
    .digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function generateLoginCode(): string {
  const env = getEnv();
  const alphabet = CROCKFORD_BASE32_ALPHABET;
  return Array.from(
    { length: env.LOGIN_CODE_LENGTH },
    () => alphabet[randomInt(0, alphabet.length)],
  ).join("");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

const SECRET_CIPHER_VERSION = "v1";

/**
 * 取配置加密根密钥并归一化为 32 字节。根密钥可能是任意长度/格式的字符串
 * （Docker 生成的是 base64(32B)，也可能是用户自定义），用 sha256 归一化以适配
 * AES-256。未配置密钥时抛错，且不输出密钥内容。
 */
function normalizeAesKey(keyMaterial: string): Buffer {
  return createHash("sha256").update(keyMaterial).digest();
}

function getEncryptionKey(): Buffer {
  const keyStr = getConfigEncryptionKey();
  if (!keyStr) {
    throw new Error(
      "配置加密密钥未配置，无法加解密配置（请设置 CONFIG_ENCRYPTION_KEY 或 CONFIG_ENCRYPTION_KEY_FILE）",
    );
  }
  return normalizeAesKey(keyStr);
}

function encryptWithKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_CIPHER_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    data.toString("base64"),
  ].join(":");
}

function decryptWithKey(key: Buffer, payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== SECRET_CIPHER_VERSION) {
    throw new Error("配置密文格式无效");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * 用配置加密根密钥对明文做 AES-256-GCM 加密，用于把配置（含密钥）加密落库。
 * 输出格式：`v1:<ivBase64>:<authTagBase64>:<密文Base64>`，版本前缀便于将来轮换。
 */
export function encryptSecret(plaintext: string): string {
  return encryptWithKey(getEncryptionKey(), plaintext);
}

/**
 * 解密 encryptSecret 生成的密文。格式非法、版本不符、密文/authTag 被篡改或密钥
 * 不匹配时均抛错，不静默返回错误明文。
 */
export function decryptSecret(payload: string): string {
  return decryptWithKey(getEncryptionKey(), payload);
}

function getAuthTaskEncryptionKey(): Buffer {
  return normalizeAesKey(`auth-task-payload:v1:${getEnv().SESSION_SECRET}`);
}

export function encryptAuthTaskSecret(plaintext: string): string {
  return encryptWithKey(getAuthTaskEncryptionKey(), plaintext);
}

export function decryptAuthTaskSecret(payload: string): string {
  return decryptWithKey(getAuthTaskEncryptionKey(), payload);
}
