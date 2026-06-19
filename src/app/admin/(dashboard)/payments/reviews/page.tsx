import { ReviewActions } from "@/components/admin/review-actions";
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
import type { Translate } from "@/modules/i18n";
import { getT } from "@/modules/i18n/server";
import { listPaymentRequests } from "@/modules/payment";

export const dynamic = "force-dynamic";

const STATUS_KEYS: Record<
  string,
  { key: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  pending_review: { key: "admin.reviews.pendingStatus", variant: "outline" },
  pending_payment: { key: "admin.reviews.pendingPayment", variant: "outline" },
  approved: { key: "admin.reviews.approved", variant: "default" },
  rejected: { key: "admin.reviews.rejected", variant: "destructive" },
  cancelled: { key: "admin.reviews.cancelled", variant: "secondary" },
  reversed: { key: "admin.reviews.reversed", variant: "secondary" },
};

export default async function AdminPaymentReviewsPage() {
  const requests = await listPaymentRequests();
  const pending = requests.filter((r) => r.request.status === "pending_review");
  const others = requests.filter((r) => r.request.status !== "pending_review");
  const t = await getT();

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h1 className="text-xl font-bold">{t("admin.reviews.title")}</h1>
        <h2 className="font-semibold">{t("admin.reviews.pending", { count: pending.length })}</h2>
        <RequestTable rows={pending} showActions t={t} />
      </div>
      <div className="space-y-4">
        <h2 className="font-semibold">{t("admin.reviews.history")}</h2>
        <RequestTable rows={others} t={t} />
      </div>
    </div>
  );
}

function RequestTable({
  rows,
  showActions,
  t,
}: {
  rows: Awaited<ReturnType<typeof listPaymentRequests>>;
  showActions?: boolean;
  t: Translate;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("admin.common.empty")}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("admin.reviews.fanEmail")}</TableHead>
          <TableHead>{t("admin.reviews.tier")}</TableHead>
          <TableHead>{t("admin.reviews.price")}</TableHead>
          <TableHead>{t("admin.reviews.proof")}</TableHead>
          <TableHead>{t("admin.reviews.note")}</TableHead>
          <TableHead>{t("admin.reviews.submittedAt")}</TableHead>
          <TableHead>{t("admin.common.status")}</TableHead>
          {showActions && <TableHead>{t("admin.common.actions")}</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ request, tier, userEmail }) => {
          const status = STATUS_KEYS[request.status];
          return (
            <TableRow key={request.id}>
              <TableCell>{userEmail}</TableCell>
              <TableCell>{tier.name}</TableCell>
              <TableCell>{request.amountLabel}</TableCell>
              <TableCell>
                {request.proofFileId ? (
                  <a
                    href={`/api/files/${request.proofFileId}/download`}
                    target="_blank"
                    className="text-primary underline"
                  >
                    {t("admin.reviews.viewProof")}
                  </a>
                ) : (
                  <span className="text-muted-foreground">{t("admin.common.none")}</span>
                )}
              </TableCell>
              <TableCell className="max-w-40 truncate text-muted-foreground">
                {request.note ?? "—"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDateTime(request.createdAt)}
              </TableCell>
              <TableCell>
                <Badge variant={status.variant}>{t(status.key)}</Badge>
              </TableCell>
              {showActions && (
                <TableCell>
                  <ReviewActions requestId={request.id} />
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
