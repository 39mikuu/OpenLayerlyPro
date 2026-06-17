import { getDb } from "@/db";
import { appEvents } from "@/db/schema";
import { logger } from "@/lib/logger";

export type AppEventType =
  | "site_initialized"
  | "admin_login"
  | "user_login"
  | "membership_created"
  | "payment_request_created"
  | "payment_request_approved"
  | "payment_request_rejected"
  | "post_published"
  | "file_uploaded"
  | "file_downloaded";

export async function recordEvent(
  type: AppEventType,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    await getDb()
      .insert(appEvents)
      .values({ type, payloadJson: payload ?? null });
  } catch (err) {
    logger.error("事件记录失败", {
      type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
