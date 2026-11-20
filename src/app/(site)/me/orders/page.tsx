import { redirect } from "next/navigation";

import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/modules/auth/session";
import { canEnterInside } from "@/modules/blog/access";
import { requireInsidePage } from "@/modules/blog/reader-page";
import { getT } from "@/modules/i18n/server";
import { listMyPaymentRequestDetails } from "@/modules/payment";
import { formatPaymentRejectionReviewNote } from "@/modules/payment/rejection-note";
import { getActiveTheme, type OrderView } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function MyOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ paid?: string }>;
}) {
  const readerArea = getEnv().PERSONAL_BLOG_MODE;
  const user = readerArea
    ? await requireInsidePage("/inside/me/orders", false)
    : await getCurrentUser();
  if (!user) redirect("/login");
  const canSubscribe = !readerArea || (await canEnterInside(user));
  const [orders, theme, t] = await Promise.all([
    listMyPaymentRequestDetails(user.id),
    getActiveTheme(),
    getT(),
  ]);

  const orderViews: OrderView[] = orders.map(({ request, tier, paymentMethod }) => ({
    id: request.id,
    tierName: tier.name,
    paymentMethodName: request.flow === "auto" ? "Stripe" : (paymentMethod?.name ?? null),
    status: request.status,
    amountLabel: request.amountLabel,
    durationDays: request.durationDays,
    createdAt: request.createdAt,
    note: request.note,
    reviewNote: formatPaymentRejectionReviewNote(request.reviewNote, t),
  }));

  const { paid } = await searchParams;
  const MeOrders = theme.components.MeOrders;
  return (
    <MeOrders
      view={{ readerArea, canSubscribe, orders: orderViews, paymentProcessing: paid === "1" }}
      t={t}
    />
  );
}
