import { DeleteButton } from "@/components/admin/delete-button";
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
import { listFiles } from "@/modules/file";
import { getT } from "@/modules/i18n/server";

export const dynamic = "force-dynamic";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default async function AdminFilesPage() {
  const files = await listFiles();
  const t = await getT();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.files.title")}</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("admin.files.name")}</TableHead>
            <TableHead>{t("admin.files.purpose")}</TableHead>
            <TableHead>{t("admin.files.size")}</TableHead>
            <TableHead>{t("admin.files.storage")}</TableHead>
            <TableHead>{t("admin.files.uploadedAt")}</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((f) => (
            <TableRow key={f.id}>
              <TableCell className="max-w-60 truncate">
                <a href={`/api/files/${f.id}/download`} target="_blank" className="hover:underline">
                  {f.originalName}
                </a>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{f.purpose}</Badge>
              </TableCell>
              <TableCell>{formatSize(f.sizeBytes)}</TableCell>
              <TableCell>{f.storageDriver}</TableCell>
              <TableCell className="text-muted-foreground">{formatDateTime(f.createdAt)}</TableCell>
              <TableCell>
                <DeleteButton
                  path={`/api/admin/files/${f.id}`}
                  confirmText={t("admin.files.confirmDelete", { name: f.originalName })}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {files.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("admin.files.empty")}</p>
      )}
    </div>
  );
}
