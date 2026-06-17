import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  findOrCreateUserByEmail: vi.fn(),
  touchLastLogin: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/crypto", () => ({
  generateLoginCode: () => "123456",
  hmacSha256: (input: string) => `hash:${input}`,
  safeEqualHex: (a: string, b: string) => a === b,
}));
vi.mock("@/modules/user", () => ({
  findOrCreateUserByEmail: mocks.findOrCreateUserByEmail,
  touchLastLogin: mocks.touchLastLogin,
}));
vi.mock("@/modules/system/events", () => ({
  recordEvent: mocks.recordEvent,
}));

function dbWithExecuteQueues(queues: unknown[][]) {
  const transaction = vi.fn(
    async (callback: (tx: { execute: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const queue = queues.shift();
      if (!queue) throw new Error("missing execute queue");
      const execute = vi.fn(async () => queue.shift() ?? []);
      return callback({ execute });
    },
  );
  mocks.getDb.mockReturnValue({ transaction });
  return { transaction };
}

describe("verifyLoginCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOrCreateUserByEmail.mockResolvedValue({ id: "user-1", email: "fan@example.com" });
    mocks.touchLastLogin.mockResolvedValue(undefined);
    mocks.recordEvent.mockResolvedValue(undefined);
  });

  it("attemptCount 已达到上限时返回 429", async () => {
    dbWithExecuteQueues([[[], [{ attempt_count: 5 }]]]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(verifyLoginCode("fan@example.com", "123456")).rejects.toMatchObject({
      status: 429,
      code: "codeAttemptsExceeded",
    });
    expect(mocks.findOrCreateUserByEmail).not.toHaveBeenCalled();
  });

  it("错误验证码会消耗一次尝试并返回 codeIncorrect", async () => {
    const { transaction } = dbWithExecuteQueues([
      [[{ id: "code-1", code_hash: "hash:123456", attempt_count: 1 }]],
    ]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(verifyLoginCode("fan@example.com", "000000")).rejects.toMatchObject({
      status: 400,
      code: "codeIncorrect",
    });
    const tx = transaction.mock.calls[0][0];
    expect(tx).toBeTypeOf("function");
    expect(mocks.findOrCreateUserByEmail).not.toHaveBeenCalled();
  });

  it("正确验证码会设置 usedAt 并登录用户", async () => {
    dbWithExecuteQueues([
      [[{ id: "code-1", code_hash: "hash:123456", attempt_count: 1 }], [{ id: "code-1" }]],
    ]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(verifyLoginCode(" Fan@Example.com ", "123456", "ja")).resolves.toMatchObject({
      id: "user-1",
    });
    expect(mocks.findOrCreateUserByEmail).toHaveBeenCalledWith("fan@example.com");
    expect(mocks.touchLastLogin).toHaveBeenCalledWith("user-1", "ja");
    expect(mocks.recordEvent).toHaveBeenCalledWith("user_login", { userId: "user-1" });
  });

  it("usedAt 已存在或无活动验证码时不能再次登录", async () => {
    dbWithExecuteQueues([[[], []]]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(verifyLoginCode("fan@example.com", "123456")).rejects.toMatchObject({
      status: 400,
      code: "codeExpired",
    });
  });

  it("并发校验同一正确验证码时最多成功一次", async () => {
    let used = false;
    const transaction = vi.fn(
      (() => {
        let chain: Promise<unknown> = Promise.resolve();
        return async (
          callback: (tx: { execute: ReturnType<typeof vi.fn> }) => Promise<unknown>,
        ) => {
          const run = chain.then(async () => {
            let call = 0;
            const execute = vi.fn(async () => {
              call += 1;
              if (call === 1) {
                return used ? [] : [{ id: "code-1", code_hash: "hash:123456", attempt_count: 1 }];
              }
              if (!used) {
                used = true;
                return [{ id: "code-1" }];
              }
              return [];
            });
            return callback({ execute });
          });
          chain = run.catch(() => {});
          return run;
        };
      })(),
    );
    mocks.getDb.mockReturnValue({ transaction });
    const { verifyLoginCode } = await import("./login-code");

    const results = await Promise.allSettled([
      verifyLoginCode("fan@example.com", "123456"),
      verifyLoginCode("fan@example.com", "123456"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("并发错误尝试不能绕过 MAX_ATTEMPTS", async () => {
    let attemptCount = 4;
    const transaction = vi.fn(
      (() => {
        let chain: Promise<unknown> = Promise.resolve();
        return async (
          callback: (tx: { execute: ReturnType<typeof vi.fn> }) => Promise<unknown>,
        ) => {
          const run = chain.then(async () => {
            let call = 0;
            const execute = vi.fn(async () => {
              call += 1;
              if (call === 1) {
                if (attemptCount >= 5) return [];
                attemptCount += 1;
                return [{ id: "code-1", code_hash: "hash:123456", attempt_count: attemptCount }];
              }
              return [{ attempt_count: attemptCount }];
            });
            return callback({ execute });
          });
          chain = run.catch(() => {});
          return run;
        };
      })(),
    );
    mocks.getDb.mockReturnValue({ transaction });
    const { verifyLoginCode } = await import("./login-code");

    const results = await Promise.allSettled([
      verifyLoginCode("fan@example.com", "000000"),
      verifyLoginCode("fan@example.com", "000000"),
    ]);

    expect(results).toHaveLength(2);
    expect(
      results.some(
        (result) =>
          result.status === "rejected" &&
          (result.reason as { code?: string }).code === "codeAttemptsExceeded",
      ),
    ).toBe(true);
    expect(attemptCount).toBe(5);
  });
});
