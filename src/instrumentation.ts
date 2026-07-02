/**
 * Next.js 服务启动钩子：启动时立即执行环境变量校验。
 * 生产环境配置不安全（如默认/过短的 SESSION_SECRET）时 getEnv 会抛错，
 * 应用直接启动失败，而不是等到首个请求才报错。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { getEnv } = await import("@/lib/env");
      const env = getEnv();
      if (process.env.NEXT_PHASE !== "phase-production-build") {
        const { getSessionSecret } = await import("@/modules/security/session-secret");
        getSessionSecret();
      }
      if (env.APP_INSTANCE_COUNT > 1) {
        console.warn(
          "APP_INSTANCE_COUNT is greater than 1, but v1.0 rate limits are process-local and not globally consistent across replicas.",
        );
      }
      const { startTaskDispatcher } = await import("@/modules/tasks/dispatcher");
      startTaskDispatcher();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }
}
