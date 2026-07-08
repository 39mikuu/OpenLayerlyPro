import { MobileDataCard, MobileDataField, ResponsiveDataView } from "@/components/admin/primitives";
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
import { listPaymentRequestsPage, type PaymentRequestDetail } from "@/modules/payment";

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

export default async function AdminPaymentReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ pendingCursor?: string; historyCursor?: string }>;
}) {
  const filters = await searchParams;
  const [pendingPage, historyPage] = await Promise.all([
    listPaymentRequestsPage({
      status: "pending_review",
      cursor: filters.pendingCursor,
    }),
    listPaymentRequestsPage({
      excludeStatus: "pending_review",
      cursor: filters.historyCursor,
    }),
  ]);
  const t = await getT();

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h1 className="text-xl font-bold">{t("admin.reviews.title")}</h1>
        <h2 id="admin-payment-reviews-pending-heading" tabIndex={-1} className="font-semibold">
          {t("admin.reviews.pending")}
        </h2>
        <RequestTable rows={pendingPage.items} showActions t={t} />
        {pendingPage.nextCursor && (
          <a
            href={paymentPageHref(filters, "pendingCursor", pendingPage.nextCursor)}
            className="text-primary text-sm font-medium hover:underline"
          >
            {t("admin.common.nextPage")}
          </a>
        )}
        {filters.pendingCursor && (
          <a
            href={paymentPageHref(filters, "pendingCursor")}
            className="text-primary text-sm font-medium hover:underline"
          >
            {t("admin.common.firstPage")}
          </a>
        )}
      </div>
      <div className="space-y-4">
        <h2 className="font-semibold">{t("admin.reviews.history")}</h2>
        <RequestTable rows={historyPage.items} t={t} />
        {historyPage.nextCursor && (
          <a
            href={paymentPageHref(filters, "historyCursor", historyPage.nextCursor)}
            className="text-primary text-sm font-medium hover:underline"
          >
            {t("admin.common.nextPage")}
          </a>
        )}
        {filters.historyCursor && (
          <a
            href={paymentPageHref(filters, "historyCursor")}
            className="text-primary text-sm font-medium hover:underline"
          >
            {t("admin.common.firstPage")}
          </a>
        )}
      </div>
    </div>
  );
}

function RequestTable({
  rows,
  showActions,
  t,
}: {
  rows: PaymentRequestDetail[];
  showActions?: boolean;
  t: Translate;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("admin.common.empty")}</p>;
  }
  return (
    <ResponsiveDataView
      table={
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
                  <TableCell className="max-w-64 whitespace-normal break-all">
                    {userEmail}
                  </TableCell>
                  <TableCell className="max-w-48 whitespace-normal break-words">
                    {tier.name}
                  </TableCell>
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
                  <TableCell className="max-w-60 whitespace-normal text-muted-foreground">
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
                      <ReviewActions
                        context={reviewContext({ request, tierName: tier.name, userEmail })}
                      />
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      }
      cards={rows.map(({ request, tier, userEmail }) => {
        const status = STATUS_KEYS[request.status];
        return (
          <MobileDataCard
            key={request.id}
            title={userEmail}
            eyebrow={t("admin.reviews.fanEmail")}
            actions={
              showActions ? (
                <ReviewActions
                  context={reviewContext({ request, tierName: tier.name, userEmail })}
                />
              ) : null
            }
          >
            <div className="flex flex-wrap gap-2">
              <Badge variant={status.variant}>{t(status.key)}</Badge>
              <Badge variant="outline">{request.amountLabel}</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MobileDataField label={t("admin.reviews.tier")}>{tier.name}</MobileDataField>
              <MobileDataField
                label={t("admin.reviews.submittedAt")}
                valueClassName="text-muted-foreground"
              >
                {formatDateTime(request.createdAt)}
              </MobileDataField>
            </div>
            <MobileDataField label={t("admin.reviews.proof")}>
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
            </MobileDataField>
            <MobileDataField label={t("admin.reviews.note")} valueClassName="text-muted-foreground">
              {request.note ?? "—"}
            </MobileDataField>
          </MobileDataCard>
        );
      })}
    />
  );
}

function reviewContext({
  request,
  tierName,
  userEmail,
}: {
  request: PaymentRequestDetail["request"];
  tierName: string;
  userEmail: string;
}) {
  return {
    amountLabel: request.amountLabel,
    note: request.note,
    proofHref: request.proofFileId ? `/api/files/${request.proofFileId}/download` : null,
    requestId: request.id,
    submittedAtLabel: formatDateTime(request.createdAt),
    tierName,
    userEmail,
  };
}

export function paymentPageHref(
  current: { pendingCursor?: string; historyCursor?: string },
  key: "pendingCursor" | "historyCursor",
  cursor?: string,
): string {
  const params = new URLSearchParams();
  if (current.pendingCursor) params.set("pendingCursor", current.pendingCursor);
  if (current.historyCursor) params.set("historyCursor", current.historyCursor);
  if (cursor) params.set(key, cursor);
  else params.delete(key);
  const query = params.toString();
  return query ? `/admin/payments/reviews?${query}` : "/admin/payments/reviews";
}
