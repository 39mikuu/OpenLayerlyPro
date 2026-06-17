import { DeleteButton } from "@/components/admin/delete-button";
import { MembershipGrantForm } from "@/components/admin/membership-grant-form";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { getT } from "@/modules/i18n/server";
import { listMemberships, listTiers } from "@/modules/membership";

export const dynamic = "force-dynamic";

const SOURCE_KEYS: Record<string, string> = {
  manual: "admin.memberships.sourceManual",
  payment_review: "admin.memberships.sourcePayment",
  gift: "admin.memberships.sourceGift",
  external: "admin.memberships.sourceExternal",
};

export default async function AdminMembershipsPage() {
  const [records, tiers] = await Promise.all([listMemberships(), listTiers({ activeOnly: true })]);
  const now = new Date();
  const t = await getT();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.memberships.title")}</h1>
      <MembershipGrantForm tiers={tiers.map((t) => ({ id: t.id, name: t.name }))} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("admin.memberships.user")}</TableHead>
            <TableHead>{t("admin.memberships.tier")}</TableHead>
            <TableHead>{t("admin.common.source")}</TableHead>
            <TableHead>{t("admin.memberships.validity")}</TableHead>
            <TableHead>{t("admin.common.status")}</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map(({ membership, tier, userEmail }) => {
            const active = membership.startsAt <= now && membership.endsAt > now;
            return (
              <TableRow key={membership.id}>
                <TableCell>{userEmail}</TableCell>
                <TableCell>{tier.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {SOURCE_KEYS[membership.source]
                    ? t(SOURCE_KEYS[membership.source])
                    : membership.source}
                </TableCell>
                <TableCell>
                  {formatDate(membership.startsAt)} ~ {formatDate(membership.endsAt)}
                </TableCell>
                <TableCell>
                  {active ? (
                    <Badge>{t("admin.memberships.active")}</Badge>
                  ) : (
                    <Badge variant="secondary">{t("admin.memberships.expired")}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <DeleteButton
                    path={`/api/admin/memberships/${membership.id}`}
                    confirmText={t("admin.memberships.confirmDelete", {
                      email: userEmail,
                      tier: tier.name,
                    })}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {records.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("admin.memberships.empty")}</p>
      )}
    </div>
  );
}
