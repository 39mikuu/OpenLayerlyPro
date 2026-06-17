import { redirect } from "next/navigation";

import { getCurrentUser } from "@/modules/auth/session";
import { getT } from "@/modules/i18n/server";
import { listMyPaymentRequestDetails } from "@/modules/payment";
import { getActiveTheme, type OrderView } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function MyOrdersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [orders, theme, t] = await Promise.all([
    listMyPaymentRequestDetails(user.id),
    getActiveTheme(),
    getT(),
  ]);

  const orderViews: OrderView[] = orders.map(({ request, tier, paymentMethod }) => ({
    id: request.id,
    tierName: tier.name,
    paymentMethodName: paymentMethod?.name ?? null,
    status: request.status,
    amountLabel: request.amountLabel,
    durationDays: request.durationDays,
    createdAt: request.createdAt,
    note: request.note,
    reviewNote: request.reviewNote,
  }));

  const MeOrders = theme.components.MeOrders;
  return <MeOrders view={{ orders: orderViews }} t={t} />;
}
