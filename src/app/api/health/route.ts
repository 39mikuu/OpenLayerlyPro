import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 存活检查：只确认进程在运行，不依赖任何外部服务 */
export async function GET() {
  return NextResponse.json({ ok: true, status: "healthy" });
}
