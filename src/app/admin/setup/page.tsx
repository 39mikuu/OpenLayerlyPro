import { redirect } from "next/navigation";

import { SetupForm } from "@/components/admin/setup-form";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { getT } from "@/modules/i18n/server";
import { isInitialized } from "@/modules/site";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isInitialized()) redirect("/admin");
  const t = await getT();
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6 py-12">
        <div className="text-center space-y-2">
          <div className="flex justify-end">
            <LocaleSwitcher />
          </div>
          <h1 className="text-2xl font-bold">{t("setup.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("setup.description")}</p>
        </div>
        <SetupForm />
      </div>
    </div>
  );
}
