import { PaymentMethodManager } from "@/components/admin/payment-method-manager";
import { getT } from "@/modules/i18n/server";
import { listPaymentMethods } from "@/modules/payment";

export const dynamic = "force-dynamic";

export default async function AdminPaymentMethodsPage() {
  const methods = await listPaymentMethods();
  const t = await getT();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.paymentMethods.title")}</h1>
      <PaymentMethodManager
        methods={methods.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          qrFileId: m.qrFileId,
          isActive: m.isActive,
          sortOrder: m.sortOrder,
        }))}
      />
    </div>
  );
}
