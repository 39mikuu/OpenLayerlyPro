import { MobileDataCard, MobileDataField, ResponsiveDataView } from "@/components/admin/primitives";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { listDownloadLogs } from "@/modules/download";
import { getT } from "@/modules/i18n/server";

export const dynamic = "force-dynamic";

export default async function AdminDownloadsPage() {
  const logs = await listDownloadLogs();
  const t = await getT();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.downloads.title")}</h1>
      <ResponsiveDataView
        table={
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin.downloads.user")}</TableHead>
                <TableHead>{t("admin.downloads.file")}</TableHead>
                <TableHead>{t("admin.downloads.time")}</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>{t("admin.downloads.storage")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map(({ log, userEmail, fileName }) => (
                <TableRow key={log.id}>
                  <TableCell className="max-w-64 whitespace-normal break-all">
                    {userEmail ?? t("admin.downloads.anonymous")}
                  </TableCell>
                  <TableCell className="max-w-72 whitespace-normal break-words">
                    {fileName ?? log.fileId}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(log.createdAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{log.ip ?? "—"}</TableCell>
                  <TableCell>{log.storageDriver}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        }
        cards={logs.map(({ log, userEmail, fileName }) => (
          <MobileDataCard
            key={log.id}
            title={fileName ?? log.fileId}
            eyebrow={t("admin.downloads.file")}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <MobileDataField label={t("admin.downloads.user")}>
                {userEmail ?? t("admin.downloads.anonymous")}
              </MobileDataField>
              <MobileDataField label={t("admin.downloads.storage")}>
                {log.storageDriver}
              </MobileDataField>
              <MobileDataField
                label={t("admin.downloads.time")}
                valueClassName="text-muted-foreground"
              >
                {formatDateTime(log.createdAt)}
              </MobileDataField>
              <MobileDataField label="IP" valueClassName="text-muted-foreground">
                {log.ip ?? "—"}
              </MobileDataField>
            </div>
          </MobileDataCard>
        ))}
      />
      {logs.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("admin.downloads.empty")}</p>
      )}
    </div>
  );
}
