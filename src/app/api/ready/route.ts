import { NextRequest, NextResponse } from "next/server";

import { getReadiness } from "@/modules/system/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 就绪检查：数据库可连接、配置可读取、配置加密密钥可用。
 * 可选 ?integrations=true 附带集成探测（信息性，不影响 200/503 判定）。
 */
export async function GET(req: NextRequest) {
  const includeIntegrations = new URL(req.url).searchParams.get("integrations") === "true";
  const { ready, checks, integrations } = await getReadiness({ includeIntegrations });
  return NextResponse.json(
    {
      ok: ready,
      status: ready ? "ready" : "not_ready",
      checks,
      ...(integrations ? { integrations } : {}),
    },
    { status: ready ? 200 : 503 },
  );
}
