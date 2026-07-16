import { PageHeader, StatusBadge } from "@/components/admin/primitives";
import { SupporterWallModerationActions } from "@/components/admin/supporter-wall-moderation-actions";
import { SupporterWallSettingsForm } from "@/components/admin/supporter-wall-settings-form";
import { Button } from "@/components/ui/button";
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
import {
  getSupporterWallSettings,
  listSupporterWallEntriesPage,
  type SupporterWallAdminListItem,
} from "@/modules/supporter-wall";

export const dynamic = "force-dynamic";

function statusTone(status: SupporterWallAdminListItem["status"]) {
  if (status === "approved") return "success" as const;
  if (status === "hidden") return "neutral" as const;
  return "warning" as const;
}

export default async function AdminSupporterWallPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const params = await searchParams;
  const [page, settings, t] = await Promise.all([
    listSupporterWallEntriesPage({ cursor: params.cursor }),
    getSupporterWallSettings(),
    getT(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("admin.supporterWall.title")}
        description={t("admin.supporterWall.description")}
      />

      <section className="rounded-xl border bg-card p-5">
        <h2 className="font-semibold">{t("admin.supporterWall.settingsTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("admin.supporterWall.settingsDescription")}
        </p>
        <div className="mt-4">
          <SupporterWallSettingsForm settings={settings} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">{t("admin.supporterWall.entriesTitle")}</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("admin.supporterWall.displayName")}</TableHead>
              <TableHead>{t("admin.supporterWall.tier")}</TableHead>
              <TableHead>{t("admin.supporterWall.dedication")}</TableHead>
              <TableHead>{t("admin.common.status")}</TableHead>
              <TableHead>{t("admin.supporterWall.updatedAt")}</TableHead>
              <TableHead>{t("admin.common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.items.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-medium">
                  {entry.displayName ?? t("admin.common.none")}
                </TableCell>
                <TableCell>{entry.activeTierName ?? t("admin.common.none")}</TableCell>
                <TableCell className="max-w-80 whitespace-pre-wrap text-sm">
                  {entry.dedication || t("admin.supporterWall.noDedication")}
                </TableCell>
                <TableCell>
                  <StatusBadge tone={statusTone(entry.status)}>
                    {t(`admin.supporterWall.status${entry.status}`)}
                  </StatusBadge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDateTime(entry.updatedAt)}
                </TableCell>
                <TableCell>
                  <SupporterWallModerationActions
                    entryId={entry.id}
                    status={entry.status}
                    version={entry.version}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {page.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin.supporterWall.empty")}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {params.cursor ? (
            <Button variant="outline" size="sm" asChild>
              <a href="/admin/supporter-wall">{t("admin.common.firstPage")}</a>
            </Button>
          ) : null}
          {page.nextCursor ? (
            <Button variant="outline" size="sm" asChild>
              <a href={`/admin/supporter-wall?cursor=${encodeURIComponent(page.nextCursor)}`}>
                {t("admin.common.nextPage")}
              </a>
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
