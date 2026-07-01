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
import { listFilesPage, listQuarantinedFilesPage } from "@/modules/file";
import { getT } from "@/modules/i18n/server";

export const dynamic = "force-dynamic";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default async function AdminFilesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; quarantinedCursor?: string }>;
}) {
  const filters = await searchParams;
  const [filesPage, quarantinedPage] = await Promise.all([
    listFilesPage({ cursor: filters.cursor }),
    listQuarantinedFilesPage({ cursor: filters.quarantinedCursor }),
  ]);
  const files = filesPage.items;
  const quarantinedFiles = quarantinedPage.items;
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
      {filesPage.nextCursor && (
        <a
          href={filesPageHref(filters, "cursor", filesPage.nextCursor)}
          className="text-primary text-sm font-medium hover:underline"
        >
          {t("admin.common.nextPage")}
        </a>
      )}
      {filters.cursor && (
        <a
          href={filesPageHref(filters, "cursor")}
          className="text-primary text-sm font-medium hover:underline"
        >
          {t("admin.common.firstPage")}
        </a>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Quarantined files</h2>
        <p className="text-sm text-muted-foreground">
          Metadata only. Quarantined bytes cannot be downloaded, previewed, exported, or overridden.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>{t("admin.files.name")}</TableHead>
              <TableHead>{t("admin.files.purpose")}</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Quarantined at</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {quarantinedFiles.map((file) => (
              <TableRow key={file.id}>
                <TableCell className="font-mono text-xs">{file.id}</TableCell>
                <TableCell className="max-w-60 truncate">{file.originalName}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{file.purpose}</Badge>
                </TableCell>
                <TableCell>{file.quarantineReason ?? "unknown"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {file.quarantinedAt ? formatDateTime(file.quarantinedAt) : "-"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {quarantinedPage.nextCursor && (
          <a
            href={filesPageHref(filters, "quarantinedCursor", quarantinedPage.nextCursor)}
            className="text-primary text-sm font-medium hover:underline"
          >
            {t("admin.common.nextPage")}
          </a>
        )}
        {filters.quarantinedCursor && (
          <a
            href={filesPageHref(filters, "quarantinedCursor")}
            className="text-primary text-sm font-medium hover:underline"
          >
            {t("admin.common.firstPage")}
          </a>
        )}
      </section>
    </div>
  );
}

export function filesPageHref(
  current: { cursor?: string; quarantinedCursor?: string },
  key: "cursor" | "quarantinedCursor",
  cursor?: string,
): string {
  const params = new URLSearchParams();
  if (current.cursor) params.set("cursor", current.cursor);
  if (current.quarantinedCursor) {
    params.set("quarantinedCursor", current.quarantinedCursor);
  }
  if (cursor) params.set(key, cursor);
  else params.delete(key);
  const query = params.toString();
  return query ? `/admin/files?${query}` : "/admin/files";
}
