import type { DbClient } from "@/db";
import { auditEvents, type Membership } from "@/db/schema";

export type AuditActor = {
  type: "admin" | "user" | "system";
  id: string | null;
};

export async function recordAudit(
  tx: DbClient,
  input: {
    entityType: string;
    entityId: string;
    action: string;
    actor: AuditActor;
    reason?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    correlationId: string;
    causationId?: string | null;
  },
): Promise<{ id: string }> {
  const [event] = await tx
    .insert(auditEvents)
    .values({
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      actorType: input.actor.type,
      actorId: input.actor.id,
      reason: input.reason ?? null,
      beforeJson: input.before ?? null,
      afterJson: input.after ?? null,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
    })
    .returning({ id: auditEvents.id });
  if (!event) throw new Error("Failed to create audit event");
  return event;
}

export function pickMembershipAudit(
  membership: Pick<Membership, "status" | "startsAt" | "endsAt" | "tierId">,
): Record<string, unknown> {
  return {
    status: membership.status,
    startsAt: membership.startsAt.toISOString(),
    endsAt: membership.endsAt.toISOString(),
    tierId: membership.tierId,
  };
}
