import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getT } from "@/modules/i18n/server";
import { getDashboardStats, getSystemStatus } from "@/modules/system/status";

export const dynamic = "force-dynamic";

export default async function AdminHomePage() {
  const [stats, status] = await Promise.all([getDashboardStats(), getSystemStatus()]);
  const smtp = status.integrations.find((integration) => integration.id === "smtp");
  const storage = status.integrations.find((integration) => integration.id === "storage");
  const t = await getT();

  const cards = [
    { label: t("admin.overview.users"), value: stats.userCount, href: "/admin/users" },
    {
      label: t("admin.overview.activeMembers"),
      value: stats.activeMemberCount,
      href: "/admin/memberships",
    },
    {
      label: t("admin.overview.pendingPayments"),
      value: stats.pendingPaymentCount,
      href: "/admin/payments/reviews",
    },
    {
      label: t("admin.overview.publishedPosts"),
      value: stats.publishedPostCount,
      href: "/admin/posts",
    },
    { label: t("admin.overview.files"), value: stats.fileCount, href: "/admin/files" },
    { label: t("admin.overview.downloads"), value: stats.downloadCount, href: "/admin/downloads" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.overview.title")}</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.label} href={c.href}>
            <Card className="hover:bg-accent/50 transition-colors">
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground font-normal">
                  {c.label}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-3xl font-bold">{c.value}</CardContent>
            </Card>
          </Link>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.overview.systemStatus")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          <p>
            {t("admin.overview.database")}：
            {t(status.databaseOk ? "admin.overview.normal" : "admin.overview.abnormal")}
          </p>
          <p>
            {t("admin.overview.smtp")}：
            {t(
              smtp?.error
                ? "admin.overview.statusFailed"
                : smtp?.configured
                  ? "admin.overview.configured"
                  : "admin.overview.notConfigured",
            )}
          </p>
          <p>
            {t("admin.overview.storageDriver")}：
            {storage?.error
              ? t("admin.overview.statusFailed")
              : (storage?.driver ?? t("admin.overview.unknown"))}
          </p>
          <p>
            {t("admin.overview.version")}：{status.version}
          </p>
          <p>Source commit：{status.sourceCommit}</p>
          <p>Build timestamp：{status.buildTimestamp}</p>
        </CardContent>
      </Card>
    </div>
  );
}
