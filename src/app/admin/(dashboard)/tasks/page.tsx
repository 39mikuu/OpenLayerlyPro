import Link from "next/link";

import { MobileDataCard, MobileDataField, ResponsiveDataView } from "@/components/admin/primitives";
import { TaskRetryButton } from "@/components/admin/task-retry-button";
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
import { getT } from "@/modules/i18n/server";
import { countMailTaskFailures, listTasks, type TaskStatus } from "@/modules/tasks";

export const dynamic = "force-dynamic";

const STATUSES: TaskStatus[] = ["pending", "processing", "succeeded", "failed", "dead"];

const STATUS_VARIANTS: Record<TaskStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  processing: "default",
  succeeded: "outline",
  failed: "destructive",
  dead: "destructive",
};

export default async function AdminTasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const status = STATUSES.includes(params.status as TaskStatus)
    ? (params.status as TaskStatus)
    : undefined;
  const [records, mailFailures, t] = await Promise.all([
    listTasks({ status }),
    countMailTaskFailures(),
    getT(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">{t("admin.tasks.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.tasks.description")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border p-4">
          <p className="text-sm font-medium">{t("admin.tasks.businessEmail")}</p>
          <div className="mt-2 flex gap-2 text-sm">
            <Badge variant="destructive">
              {t("admin.tasks.statusfailed")}: {mailFailures.businessEmail.failed}
            </Badge>
            <Badge variant="destructive">
              {t("admin.tasks.statusdead")}: {mailFailures.businessEmail.dead}
            </Badge>
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-sm font-medium">{t("admin.tasks.loginCodeEmail")}</p>
          <div className="mt-2 flex gap-2 text-sm">
            <Badge variant="destructive">
              {t("admin.tasks.statusfailed")}: {mailFailures.loginCodeEmail.failed}
            </Badge>
            <Badge variant="destructive">
              {t("admin.tasks.statusdead")}: {mailFailures.loginCodeEmail.dead}
            </Badge>
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-sm font-medium">{t("admin.tasks.magicLinkEmail")}</p>
          <div className="mt-2 flex gap-2 text-sm">
            <Badge variant="destructive">
              {t("admin.tasks.statusfailed")}: {mailFailures.magicLinkEmail.failed}
            </Badge>
            <Badge variant="destructive">
              {t("admin.tasks.statusdead")}: {mailFailures.magicLinkEmail.dead}
            </Badge>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href="/admin/tasks" className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
          {t("admin.tasks.all")}
        </Link>
        {STATUSES.map((value) => (
          <Link
            key={value}
            href={`/admin/tasks?status=${value}`}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
          >
            {t(`admin.tasks.status${value}`)}
          </Link>
        ))}
      </div>

      <ResponsiveDataView
        table={
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin.tasks.kind")}</TableHead>
                <TableHead>{t("admin.common.status")}</TableHead>
                <TableHead>{t("admin.tasks.attempts")}</TableHead>
                <TableHead>{t("admin.tasks.runAfter")}</TableHead>
                <TableHead>{t("admin.tasks.lastError")}</TableHead>
                <TableHead>{t("admin.common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((task) => (
                <TableRow key={task.id}>
                  <TableCell>{task.kind}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[task.status]}>
                      {t(`admin.tasks.status${task.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {task.attempts} / {task.maxAttempts}
                  </TableCell>
                  <TableCell>{formatDateTime(task.runAfter)}</TableCell>
                  <TableCell className="max-w-80 whitespace-normal text-muted-foreground">
                    {task.lastError ?? t("admin.common.none")}
                  </TableCell>
                  <TableCell>
                    {(task.status === "failed" || task.status === "dead") && (
                      <TaskRetryButton taskId={task.id} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        }
        cards={records.map((task) => (
          <MobileDataCard
            key={task.id}
            title={task.kind}
            actions={
              (task.status === "failed" || task.status === "dead") && (
                <TaskRetryButton taskId={task.id} />
              )
            }
          >
            <div className="flex flex-wrap gap-2">
              <Badge variant={STATUS_VARIANTS[task.status]}>
                {t(`admin.tasks.status${task.status}`)}
              </Badge>
              <Badge
                variant="outline"
                aria-label={`${t("admin.tasks.attempts")}: ${task.attempts} / ${task.maxAttempts}`}
              >
                {task.attempts} / {task.maxAttempts}
              </Badge>
            </div>
            <MobileDataField
              label={t("admin.tasks.runAfter")}
              valueClassName="text-muted-foreground"
            >
              {formatDateTime(task.runAfter)}
            </MobileDataField>
            <MobileDataField
              label={t("admin.tasks.lastError")}
              valueClassName="text-muted-foreground"
            >
              {task.lastError ?? t("admin.common.none")}
            </MobileDataField>
          </MobileDataCard>
        ))}
      />
      {records.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("admin.tasks.empty")}</p>
      )}
    </div>
  );
}
