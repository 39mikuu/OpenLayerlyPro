import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  findOrCreateUserByEmail: vi.fn(),
  touchLastLogin: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/crypto", () => ({
  CROCKFORD_BASE32_ALPHABET: "0123456789ABCDEFGHJKMNPQRSTVWXYZ",
  generateLoginCode: () => "123456",
  hmacSha256: (input: string) => `hash:${input}`,
  hmacSha256WithPurpose: (_purpose: string, input: string) => `hash:${input}`,
  safeEqualHex: (a: string, b: string) => a === b,
}));
vi.mock("@/modules/user", () => ({
  findOrCreateUserByEmail: mocks.findOrCreateUserByEmail,
  touchLastLogin: mocks.touchLastLogin,
}));
vi.mock("@/modules/system/events", () => ({
  recordEvent: mocks.recordEvent,
}));

const TEST_CHALLENGE = "A".repeat(43);
const OTHER_CHALLENGE = "B".repeat(43);
const NEW_PROTOCOL_CODE = "123456";

function mockTxSelect(rows: unknown[] = []) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return vi.fn(() => ({ from }));
}

function dbWithExecuteQueues(queues: unknown[][]) {
  const updateWhere = vi.fn(async () => []);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const executes: ReturnType<typeof vi.fn>[] = [];
  const transaction = vi.fn(
    async (
      callback: (tx: {
        execute: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
        select: ReturnType<typeof vi.fn>;
      }) => Promise<unknown>,
    ) => {
      const queue = queues.shift();
      if (!queue) throw new Error("missing execute queue");
      const execute = vi.fn(async () => queue.shift() ?? []);
      executes.push(execute);
      return callback({ execute, update, select: mockTxSelect() });
    },
  );
  mocks.getDb.mockReturnValue({ transaction });
  return { transaction, update, updateSet, updateWhere, executes };
}

describe("verifyLoginCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOrCreateUserByEmail.mockResolvedValue({ id: "user-1", email: "fan@example.com" });
    mocks.touchLastLogin.mockResolvedValue(undefined);
    mocks.recordEvent.mockResolvedValue(undefined);
  });

  it("attemptCount 已很高时正确验证码仍可登录", async () => {
    dbWithExecuteQueues([
      [
        [
          {
            id: "code-1",
            code_hash: "hash:ABCD1234EFGH5678",
            challenge_hash: null,
            attempt_count: 99,
          },
        ],
        [{ id: "code-1" }],
      ],
    ]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(verifyLoginCode("fan@example.com", "ABCD1234EFGH5678")).resolves.toMatchObject({
      id: "user-1",
    });
    expect(mocks.findOrCreateUserByEmail).toHaveBeenCalledWith("fan@example.com");
  });

  it("错误验证码返回 codeIncorrect 且不写 attempt_count", async () => {
    const { transaction, executes } = dbWithExecuteQueues([
      [
        [
          {
            id: "code-1",
            code_hash: "hash:ABCD1234EFGH5678",
            challenge_hash: null,
            attempt_count: 1,
          },
        ],
      ],
    ]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(verifyLoginCode("fan@example.com", "0000000000000000")).rejects.toMatchObject({
      status: 400,
      code: "codeIncorrect",
    });
    expect(transaction.mock.calls[0][0]).toBeTypeOf("function");
    expect(executes[0]).toHaveBeenCalledOnce();
    expect(mocks.findOrCreateUserByEmail).not.toHaveBeenCalled();
  });

  it("正确验证码会设置 usedAt 并登录用户", async () => {
    dbWithExecuteQueues([
      [
        [
          {
            id: "code-1",
            code_hash: "hash:ABCD1234EFGH5678",
            challenge_hash: null,
            attempt_count: 1,
          },
        ],
        [{ id: "code-1" }],
      ],
    ]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(
      verifyLoginCode(" Fan@Example.com ", "ABCD1234EFGH5678", undefined, "ja"),
    ).resolves.toMatchObject({ id: "user-1" });
    expect(mocks.findOrCreateUserByEmail).toHaveBeenCalledWith("fan@example.com");
    expect(mocks.touchLastLogin).toHaveBeenCalledWith("user-1", "ja");
    expect(mocks.recordEvent).toHaveBeenCalledWith("user_login", { userId: "user-1" });
  });

  it("usedAt 已存在或无活动验证码时不能再次登录", async () => {
    dbWithExecuteQueues([[[], []]]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(verifyLoginCode("fan@example.com", "ABCD1234EFGH5678")).rejects.toMatchObject({
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
          callback: (tx: {
            execute: ReturnType<typeof vi.fn>;
            select: ReturnType<typeof vi.fn>;
          }) => Promise<unknown>,
        ) => {
          const run = chain.then(async () => {
            let call = 0;
            const execute = vi.fn(async () => {
              call += 1;
              if (call === 1) {
                return used
                  ? []
                  : [
                      {
                        id: "code-1",
                        code_hash: "hash:ABCD1234EFGH5678",
                        challenge_hash: null,
                        attempt_count: 1,
                      },
                    ];
              }
              if (!used) {
                used = true;
                return [{ id: "code-1" }];
              }
              return [];
            });
            return callback({ execute, select: mockTxSelect() });
          });
          chain = run.catch(() => {});
          return run;
        };
      })(),
    );
    mocks.getDb.mockReturnValue({ transaction });
    const { verifyLoginCode } = await import("./login-code");

    const results = await Promise.allSettled([
      verifyLoginCode("fan@example.com", "ABCD1234EFGH5678"),
      verifyLoginCode("fan@example.com", "ABCD1234EFGH5678"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("并发错误尝试只返回错误且不写 attempt_count", async () => {
    let attemptUpdates = 0;
    const transaction = vi.fn(
      (() => {
        let chain: Promise<unknown> = Promise.resolve();
        return async (
          callback: (tx: {
            execute: ReturnType<typeof vi.fn>;
            update: ReturnType<typeof vi.fn>;
            select: ReturnType<typeof vi.fn>;
          }) => Promise<unknown>,
        ) => {
          const run = chain.then(async () => {
            let call = 0;
            const execute = vi.fn(async () => {
              call += 1;
              if (call === 1) {
                return [
                  {
                    id: "code-1",
                    code_hash: "hash:ABCD1234EFGH5678",
                    challenge_hash: null,
                    attempt_count: 0,
                  },
                ];
              }
              attemptUpdates += 1;
              return [];
            });
            const update = vi.fn(() => ({
              set: vi.fn(() => ({
                where: vi.fn(async () => {
                  attemptUpdates += 1;
                  return [];
                }),
              })),
            }));
            return callback({ execute, update, select: mockTxSelect() });
          });
          chain = run.catch(() => {});
          return run;
        };
      })(),
    );
    mocks.getDb.mockReturnValue({ transaction });
    const { verifyLoginCode } = await import("./login-code");

    const results = await Promise.allSettled([
      verifyLoginCode("fan@example.com", "0000000000000000"),
      verifyLoginCode("fan@example.com", "0000000000000000"),
    ]);

    expect(results).toHaveLength(2);
    expect(
      results.every(
        (result) =>
          result.status === "rejected" &&
          (result.reason as { code?: string }).code === "codeIncorrect",
      ),
    ).toBe(true);
    expect(attemptUpdates).toBe(0);
  });

  it("新协议错误码在 challenge 匹配时写入 attempt_count", async () => {
    const { executes } = dbWithExecuteQueues([
      [
        [
          {
            id: "code-1",
            code_hash: `hash:${NEW_PROTOCOL_CODE}`,
            challenge_hash: `hash:${TEST_CHALLENGE}`,
            attempt_count: 0,
          },
        ],
        [{ attempt_count: 1 }],
      ],
    ]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(
      verifyLoginCode("fan@example.com", "000000", TEST_CHALLENGE),
    ).rejects.toMatchObject({
      status: 400,
      code: "codeIncorrect",
    });
    expect(executes[0]).toHaveBeenCalledTimes(2);
    expect(mocks.findOrCreateUserByEmail).not.toHaveBeenCalled();
  });

  it("新协议第 5 次匹配错误返回 fresh codeAttemptsExceeded", async () => {
    dbWithExecuteQueues([
      [
        [
          {
            id: "code-1",
            code_hash: `hash:${NEW_PROTOCOL_CODE}`,
            challenge_hash: `hash:${TEST_CHALLENGE}`,
            attempt_count: 4,
          },
        ],
        [{ attempt_count: 5 }],
      ],
    ]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(
      verifyLoginCode("fan@example.com", "000000", TEST_CHALLENGE),
    ).rejects.toMatchObject({
      status: 429,
      code: "codeAttemptsExceeded",
      freshAttemptExhausted: true,
      params: { rotateChallenge: 1 },
    });
    expect(mocks.findOrCreateUserByEmail).not.toHaveBeenCalled();
  });

  it("新协议高 attemptCount 时正确码不可登录", async () => {
    const { executes } = dbWithExecuteQueues([
      [
        [
          {
            id: "code-1",
            code_hash: `hash:${NEW_PROTOCOL_CODE}`,
            challenge_hash: `hash:${TEST_CHALLENGE}`,
            attempt_count: 5,
          },
        ],
      ],
    ]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(
      verifyLoginCode("fan@example.com", NEW_PROTOCOL_CODE, TEST_CHALLENGE),
    ).rejects.toMatchObject({
      status: 429,
      code: "codeAttemptsExceeded",
      freshAttemptExhausted: false,
    });
    expect(executes[0]).toHaveBeenCalledOnce();
    expect(mocks.findOrCreateUserByEmail).not.toHaveBeenCalled();
  });

  it("新协议 challenge 不匹配走普通错误且不增加 attempts", async () => {
    dbWithExecuteQueues([
      [
        [
          {
            id: "code-1",
            code_hash: `hash:${NEW_PROTOCOL_CODE}`,
            challenge_hash: `hash:${TEST_CHALLENGE}`,
            attempt_count: 2,
          },
        ],
        [{ attempt_count: 2 }],
      ],
    ]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(
      verifyLoginCode("fan@example.com", NEW_PROTOCOL_CODE, OTHER_CHALLENGE),
    ).rejects.toMatchObject({
      status: 400,
      code: "codeIncorrect",
    });
    expect(mocks.findOrCreateUserByEmail).not.toHaveBeenCalled();
  });

  it("已耗尽行在 challenge 不匹配时不返回 attempts_already_exhausted", async () => {
    const { executes } = dbWithExecuteQueues([
      [
        [
          {
            id: "code-1",
            code_hash: `hash:${NEW_PROTOCOL_CODE}`,
            challenge_hash: `hash:${TEST_CHALLENGE}`,
            attempt_count: 5,
          },
        ],
        [{ attempt_count: 5 }],
      ],
    ]);
    const { verifyLoginCode } = await import("./login-code");

    await expect(
      verifyLoginCode("fan@example.com", "000000", OTHER_CHALLENGE),
    ).rejects.toMatchObject({
      status: 400,
      code: "codeIncorrect",
    });
    expect(executes[0]).toHaveBeenCalledTimes(2);
    expect(mocks.findOrCreateUserByEmail).not.toHaveBeenCalled();
  });
});
