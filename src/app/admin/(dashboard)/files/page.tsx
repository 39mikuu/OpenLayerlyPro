import { DeleteButton } from "@/components/admin/delete-button";
import { MobileDataCard, MobileDataField, ResponsiveDataView } from "@/components/admin/primitives";
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
      <ResponsiveDataView
        table={
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
                  <TableCell className="max-w-72 whitespace-normal break-words">
                    <a
                      href={`/api/files/${f.id}/download`}
                      target="_blank"
                      className="hover:underline"
                    >
                      {f.originalName}
                    </a>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{f.purpose}</Badge>
                  </TableCell>
                  <TableCell>{formatSize(f.sizeBytes)}</TableCell>
                  <TableCell>{f.storageDriver}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(f.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DeleteButton
                      path={`/api/admin/files/${f.id}`}
                      title={t("admin.files.deleteDialogTitle")}
                      description={t("admin.files.deleteDialogDescription", {
                        name: f.originalName,
                      })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        }
        cards={files.map((f) => (
          <MobileDataCard
            key={f.id}
            title={
              <a href={`/api/files/${f.id}/download`} target="_blank" className="hover:underline">
                {f.originalName}
              </a>
            }
            actions={
              <DeleteButton
                path={`/api/admin/files/${f.id}`}
                title={t("admin.files.deleteDialogTitle")}
                description={t("admin.files.deleteDialogDescription", {
                  name: f.originalName,
                })}
              />
            }
          >
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{f.purpose}</Badge>
              <Badge variant="outline">{f.storageDriver}</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MobileDataField label={t("admin.files.size")}>
                {formatSize(f.sizeBytes)}
              </MobileDataField>
              <MobileDataField
                label={t("admin.files.uploadedAt")}
                valueClassName="text-muted-foreground"
              >
                {formatDateTime(f.createdAt)}
              </MobileDataField>
            </div>
          </MobileDataCard>
        ))}
      />
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
        <ResponsiveDataView
          table={
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
                    <TableCell className="max-w-72 whitespace-normal break-words">
                      {file.originalName}
                    </TableCell>
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
          }
          cards={quarantinedFiles.map((file) => (
            <MobileDataCard key={file.id} title={file.originalName} eyebrow={file.id}>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{file.purpose}</Badge>
                <Badge variant="outline">{file.quarantineReason ?? "unknown"}</Badge>
              </div>
              <MobileDataField label="Quarantined at" valueClassName="text-muted-foreground">
                {file.quarantinedAt ? formatDateTime(file.quarantinedAt) : "-"}
              </MobileDataField>
            </MobileDataCard>
          ))}
        />
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
