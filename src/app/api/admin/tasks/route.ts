import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { listTasks, type TaskStatus } from "@/modules/tasks";

export const runtime = "nodejs";

const TASK_STATUSES: TaskStatus[] = ["pending", "processing", "succeeded", "failed", "dead"];

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const value = req.nextUrl.searchParams.get("status");
    const status = TASK_STATUSES.includes(value as TaskStatus) ? (value as TaskStatus) : undefined;
    return jsonOk(await listTasks({ status }));
  } catch (error) {
    return handleApiError(error);
  }
}
