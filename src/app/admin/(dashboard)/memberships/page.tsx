import { MembershipActions } from "@/components/admin/membership-actions";
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
import { listMembershipsPage, listTiers } from "@/modules/membership";
import {
  getMembershipDisplayState,
  type MembershipDisplayState,
} from "@/modules/membership/admin-model";

export const dynamic = "force-dynamic";

const SOURCE_KEYS: Record<string, string> = {
  manual: "admin.memberships.sourceManual",
  payment_review: "admin.memberships.sourcePayment",
  gift: "admin.memberships.sourceGift",
  external: "admin.memberships.sourceExternal",
};

const STATE_KEYS: Record<MembershipDisplayState, string> = {
  active: "admin.memberships.active",
  scheduled: "admin.memberships.scheduled",
  expired: "admin.memberships.expired",
  suspended: "admin.memberships.suspended",
  revoked: "admin.memberships.revoked",
};

export default async function AdminMembershipsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const filters = await searchParams;
  const [recordsPage, tiers] = await Promise.all([
    listMembershipsPage({ cursor: filters.cursor }),
    listTiers({ activeOnly: true }),
  ]);
  const records = recordsPage.items;
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
            const state = getMembershipDisplayState(membership);
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
                  <Badge variant={state === "active" ? "default" : "secondary"}>
                    {t(STATE_KEYS[state])}
                  </Badge>
                </TableCell>
                <TableCell>
                  <MembershipActions membershipId={membership.id} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {records.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("admin.memberships.empty")}</p>
      )}
      {recordsPage.nextCursor && (
        <a
          href={`/admin/memberships?cursor=${encodeURIComponent(recordsPage.nextCursor)}`}
          className="text-primary text-sm font-medium hover:underline"
        >
          {t("admin.common.nextPage")}
        </a>
      )}
      {filters.cursor && (
        <a href="/admin/memberships" className="text-primary text-sm font-medium hover:underline">
          {t("admin.common.firstPage")}
        </a>
      )}
    </div>
  );
}
