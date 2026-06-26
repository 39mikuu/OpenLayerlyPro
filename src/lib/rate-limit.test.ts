import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __rateLimitStoreSizeForTests,
  __resetRateLimitForTests,
  isRateLimited,
  rateLimit,
  retryAfterSeconds,
} from "./rate-limit";

// rate-limit 使用进程内单例 store + Date.now()，因此用假定时器控制时间，
// 并为每个用例使用唯一 key 以避免相互污染。
describe("rateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    __resetRateLimitForTests();
    vi.useRealTimers();
  });

  it("在窗口内允许请求直到达到上限", () => {
    const key = "test-allow";
    expect(rateLimit(key, 3, 1000)).toBe(true);
    expect(rateLimit(key, 3, 1000)).toBe(true);
    expect(rateLimit(key, 3, 1000)).toBe(true);
  });

  it("达到上限后拒绝后续请求", () => {
    const key = "test-reject";
    rateLimit(key, 2, 1000);
    rateLimit(key, 2, 1000);
    expect(rateLimit(key, 2, 1000)).toBe(false);
  });

  it("只读检查不会消费容量并会随窗口恢复", () => {
    const key = "test-peek";

    expect(isRateLimited(key, 2, 1000)).toBe(false);
    expect(rateLimit(key, 2, 1000)).toBe(true);
    expect(isRateLimited(key, 2, 1000)).toBe(false);
    expect(rateLimit(key, 2, 1000)).toBe(true);
    expect(isRateLimited(key, 2, 1000)).toBe(true);
    expect(rateLimit(key, 2, 1000)).toBe(false);

    vi.setSystemTime(1001);
    expect(isRateLimited(key, 2, 1000)).toBe(false);
    expect(__rateLimitStoreSizeForTests()).toBe(0);
  });

  it("窗口滑过后恢复放行", () => {
    const key = "test-slide";
    rateLimit(key, 1, 1000);
    expect(rateLimit(key, 1, 1000)).toBe(false);
    vi.setSystemTime(1001);
    expect(rateLimit(key, 1, 1000)).toBe(true);
  });

  it("短窗口 bucket 到期后会被清理，不再至少保留一小时", () => {
    expect(rateLimit("test-short-window", 1, 1000)).toBe(true);
    expect(__rateLimitStoreSizeForTests()).toBe(1);

    vi.setSystemTime(61_001);
    expect(rateLimit("test-next-key", 1, 1000)).toBe(true);

    expect(__rateLimitStoreSizeForTests()).toBe(1);
  });

  it("长窗口 bucket 仍按自己的窗口保留", () => {
    expect(rateLimit("test-long-window", 1, 60 * 60 * 1000)).toBe(true);

    vi.setSystemTime(61_001);
    expect(rateLimit("test-next-long-key", 1, 1000)).toBe(true);

    expect(__rateLimitStoreSizeForTests()).toBe(2);
  });

  it("大量随机 key 超过上限时不会无限增长", () => {
    for (let i = 0; i < 10_050; i += 1) {
      expect(rateLimit(`test-many-${i}`, 1, 60 * 60 * 1000)).toBe(true);
    }

    expect(__rateLimitStoreSizeForTests()).toBeLessThanOrEqual(10_000);
  });
});

describe("retryAfterSeconds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    __resetRateLimitForTests();
    vi.useRealTimers();
  });

  it("返回距最早一次请求过期的剩余秒数", () => {
    const key = "test-retry";
    rateLimit(key, 1, 5000);
    expect(retryAfterSeconds(key, 5000)).toBe(5);
  });

  it("无记录时返回 0", () => {
    expect(retryAfterSeconds("test-retry-empty", 5000)).toBe(0);
  });

  it("过期记录返回 0 并清理 bucket", () => {
    const key = "test-retry-expired";
    rateLimit(key, 1, 1000);
    vi.setSystemTime(1001);

    expect(retryAfterSeconds(key, 1000)).toBe(0);
    expect(__rateLimitStoreSizeForTests()).toBe(0);
  });
});
