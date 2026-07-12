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
import { listNotificationCampaignAdminSummaries } from "@/modules/notifications/admin";

export const dynamic = "force-dynamic";

const DELIVERY_KEYS = [
  "queued",
  "sending",
  "accepted",
  "suppressed",
  "skipped",
  "deferred",
  "failed",
  "dead",
];
const ATTEMPT_KEYS = [
  "accepted",
  "permanent_failure",
  "transient_failure",
  "suppressed_skip",
  "budget_defer",
  "pacing_defer",
  "preference_disabled_skip",
  "post_not_published_skip",
  "access_lost_skip",
  "user_missing_skip",
  "stale_skip",
  "needs_operator_defer",
];

function compactCounts(keys: string[], counts: Record<string, number>): string {
  const parts = keys
    .map((key) => [key, counts[key] ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}:${count}`);
  return parts.length > 0 ? parts.join(" / ") : "0";
}

export default async function AdminNotificationsPage() {
  const [campaigns, t] = await Promise.all([listNotificationCampaignAdminSummaries(), getT()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">{t("admin.notifications.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.notifications.description")}</p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("admin.notifications.campaign")}</TableHead>
            <TableHead>{t("admin.notifications.post")}</TableHead>
            <TableHead>{t("admin.common.status")}</TableHead>
            <TableHead>{t("admin.common.source")}</TableHead>
            <TableHead>{t("admin.notifications.deliveryCounts")}</TableHead>
            <TableHead>{t("admin.notifications.attemptCounts")}</TableHead>
            <TableHead>{t("admin.notifications.expansion")}</TableHead>
            <TableHead>{t("admin.tasks.lastError")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {campaigns.map((campaign) => (
            <TableRow key={campaign.id}>
              <TableCell className="font-mono text-xs">{campaign.id}</TableCell>
              <TableCell className="max-w-56 whitespace-normal">
                <p className="font-medium">{campaign.postTitle ?? t("admin.common.none")}</p>
                <p className="text-xs text-muted-foreground">
                  {campaign.postSlug ?? campaign.postId}
                </p>
              </TableCell>
              <TableCell>
                <Badge variant={campaign.status === "dead" ? "destructive" : "secondary"}>
                  {campaign.status}
                </Badge>
              </TableCell>
              <TableCell>{campaign.source}</TableCell>
              <TableCell className="max-w-72 whitespace-normal text-xs">
                {compactCounts(DELIVERY_KEYS, campaign.deliveryCounts)}
              </TableCell>
              <TableCell className="max-w-72 whitespace-normal text-xs">
                {compactCounts(ATTEMPT_KEYS, campaign.attemptCounts)}
                {campaign.suppressionCount > 0
                  ? ` / suppressions:${campaign.suppressionCount}`
                  : ""}
              </TableCell>
              <TableCell className="max-w-56 whitespace-normal text-xs text-muted-foreground">
                <p>{campaign.cursorUserId ?? t("admin.common.none")}</p>
                <p>
                  {campaign.expansionCompletedAt
                    ? formatDateTime(campaign.expansionCompletedAt)
                    : t("admin.common.none")}
                </p>
              </TableCell>
              <TableCell className="max-w-80 whitespace-normal text-muted-foreground">
                {campaign.lastError ?? t("admin.common.none")}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {campaigns.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("admin.notifications.empty")}</p>
      )}
    </div>
  );
}
