import { AdminAccountManager } from "@/components/admin/admin-account-manager";
import { listAdminAuditHistory, listMySessions } from "@/modules/auth/admin-account";
import { requireAdminSession } from "@/modules/auth/session";
import { getT } from "@/modules/i18n/server";

export const dynamic = "force-dynamic";

export default async function AdminAccountPage() {
  const [{ user, tokenHash }, t] = await Promise.all([requireAdminSession(), getT()]);
  const [sessions, history] = await Promise.all([
    listMySessions(user.id, tokenHash),
    listAdminAuditHistory(user.id),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">{t("admin.account.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.account.description")}</p>
      </div>
      <AdminAccountManager
        email={user.email}
        sessions={sessions.map((session) => ({
          ...session,
          createdAt: session.createdAt.toISOString(),
          expiresAt: session.expiresAt.toISOString(),
        }))}
        history={history.map((event) => ({
          id: event.id,
          action: event.action,
          actorType: event.actorType,
          createdAt: event.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
