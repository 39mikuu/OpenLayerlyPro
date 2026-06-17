import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { getT } from "@/modules/i18n/server";
import { getActiveMembership } from "@/modules/membership";
import { listUsers } from "@/modules/user";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const users = await listUsers();
  const memberships = await Promise.all(users.map((u) => getActiveMembership(u.id)));
  const t = await getT();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.users.title")}</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("admin.users.email")}</TableHead>
            <TableHead>{t("admin.users.role")}</TableHead>
            <TableHead>{t("admin.users.membership")}</TableHead>
            <TableHead>{t("admin.users.registeredAt")}</TableHead>
            <TableHead>{t("admin.users.lastLogin")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user, i) => {
            const active = memberships[i];
            return (
              <TableRow key={user.id}>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  {user.role === "admin" ? (
                    <Badge>{t("admin.users.admin")}</Badge>
                  ) : (
                    <Badge variant="secondary">{t("admin.users.fan")}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {active ? (
                    <span>
                      {t("admin.users.memberUntil", {
                        tier: active.tier.name,
                        date: active.membership.endsAt.toISOString().slice(0, 10),
                      })}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t("admin.common.none")}</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(user.createdAt)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
