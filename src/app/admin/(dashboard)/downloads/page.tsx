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
              <TableCell>{userEmail ?? t("admin.downloads.anonymous")}</TableCell>
              <TableCell className="max-w-60 truncate">{fileName ?? log.fileId}</TableCell>
              <TableCell className="text-muted-foreground">
                {formatDateTime(log.createdAt)}
              </TableCell>
              <TableCell className="text-muted-foreground">{log.ip ?? "—"}</TableCell>
              <TableCell>{log.storageDriver}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {logs.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("admin.downloads.empty")}</p>
      )}
    </div>
  );
}
