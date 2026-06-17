import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await ctx.params;
  return NextResponse.redirect(new URL(`/api/files/${fileId}/download`, req.url), 307);
}
