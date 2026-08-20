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
import type { Translate } from "@/modules/i18n";
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
  "started",
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
  "lease_expired",
];

function orderedCountEntries(keys: string[], counts: Record<string, number>) {
  // Future outcomes missing from the ordered list must still render, or stuck
  // deliveries could be hidden from the operational view.
  const orderedKeys = [
    ...keys,
    ...Object.keys(counts)
      .filter((key) => !keys.includes(key))
      .sort(),
  ];
  return orderedKeys
    .map((key) => [key, counts[key] ?? 0] as const)
    .filter(([, count]) => count > 0);
}

function localizedToken(t: Translate, prefix: "delivery" | "attempt", token: string): string {
  const key = `admin.notifications.${prefix}${token}`;
  const translated = t(key);
  return translated === key ? token.replaceAll("_", " ") : translated;
}

function CountBadge({ count, label, t }: { count: number; label: string; t: Translate }) {
  return (
    <Badge
      variant="outline"
      className="h-auto max-w-full shrink whitespace-normal text-left"
      aria-label={t("admin.notifications.countLabel", { label, count })}
    >
      <span aria-hidden="true">{label}</span>
      <span className="ml-1 tabular-nums" aria-hidden="true">
        {count}
      </span>
    </Badge>
  );
}

function CountList({
  ariaLabel,
  counts,
  keys,
  prefix,
  t,
}: {
  ariaLabel: string;
  counts: Record<string, number>;
  keys: string[];
  prefix: "delivery" | "attempt";
  t: Translate;
}) {
  const entries = orderedCountEntries(keys, counts);
  if (entries.length === 0) {
    return <span className="text-muted-foreground">{t("admin.notifications.noCounts")}</span>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={ariaLabel}>
      {entries.map(([key, count]) => {
        const label = localizedToken(t, prefix, key);
        return (
          <li key={key} className="min-w-0 max-w-full">
            <CountBadge count={count} label={label} t={t} />
          </li>
        );
      })}
    </ul>
  );
}

function CampaignDiagnostics({
  campaignId,
  cursorUserId,
  t,
}: {
  campaignId: string;
  cursorUserId: string | null;
  t: Translate;
}) {
  return (
    <details className="group min-w-0">
      <summary className="cursor-pointer rounded-sm text-sm font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t("admin.notifications.diagnostics")} ·{" "}
        <span className="font-mono">{campaignId.slice(0, 8)}…</span>
      </summary>
      <div className="mt-2 grid gap-2 rounded-md bg-muted/50 p-3 text-xs">
        <div className="min-w-0">
          <p className="font-medium text-muted-foreground">{t("admin.notifications.campaign")}</p>
          <code className="break-all">{campaignId}</code>
        </div>
        <div className="min-w-0">
          <p className="font-medium text-muted-foreground">
            {t("admin.notifications.cursorUserId")}
          </p>
          <code className="break-all">{cursorUserId ?? t("admin.common.none")}</code>
        </div>
      </div>
    </details>
  );
}

function ErrorDetails({ error, t }: { error: string | null; t: Translate }) {
  if (!error) return <span className="text-muted-foreground">{t("admin.common.none")}</span>;
  return (
    <details className="group min-w-0">
      <summary className="cursor-pointer rounded-sm text-sm font-medium text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t("admin.notifications.viewError")}
      </summary>
      <p className="mt-2 break-all rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
        {error}
      </p>
    </details>
  );
}

export default async function AdminNotificationsPage() {
  const [campaigns, t] = await Promise.all([listNotificationCampaignAdminSummaries(), getT()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">{t("admin.notifications.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.notifications.description")}</p>
      </div>

      <ResponsiveDataView
        table={
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
                  <TableCell className="max-w-48 whitespace-normal">
                    <CampaignDiagnostics
                      campaignId={campaign.id}
                      cursorUserId={campaign.cursorUserId}
                      t={t}
                    />
                  </TableCell>
                  <TableCell className="max-w-56 whitespace-normal">
                    <p className="font-medium">{campaign.postTitle ?? t("admin.common.none")}</p>
                    <p className="break-all text-xs text-muted-foreground">
                      {campaign.postSlug ?? campaign.postId}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge variant={campaign.status === "dead" ? "destructive" : "secondary"}>
                      {t(`admin.notifications.status${campaign.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>{t(`admin.notifications.source_${campaign.source}`)}</TableCell>
                  <TableCell className="max-w-72 whitespace-normal text-xs">
                    <CountList
                      ariaLabel={t("admin.notifications.deliveryCounts")}
                      counts={campaign.deliveryCounts}
                      keys={DELIVERY_KEYS}
                      prefix="delivery"
                      t={t}
                    />
                  </TableCell>
                  <TableCell className="max-w-72 whitespace-normal text-xs">
                    <div className="space-y-1.5">
                      <CountList
                        ariaLabel={t("admin.notifications.attemptCounts")}
                        counts={campaign.attemptCounts}
                        keys={ATTEMPT_KEYS}
                        prefix="attempt"
                        t={t}
                      />
                      {campaign.suppressionCount > 0 ? (
                        <CountBadge
                          count={campaign.suppressionCount}
                          label={t("admin.notifications.suppressions")}
                          t={t}
                        />
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-56 whitespace-normal text-xs text-muted-foreground">
                    <p className="font-medium">{t("admin.notifications.expansionCompleted")}</p>
                    <p>
                      {campaign.expansionCompletedAt
                        ? formatDateTime(campaign.expansionCompletedAt)
                        : t("admin.common.none")}
                    </p>
                  </TableCell>
                  <TableCell className="max-w-80 whitespace-normal">
                    <ErrorDetails error={campaign.lastError} t={t} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        }
        cards={campaigns.map((campaign) => (
          <MobileDataCard
            key={campaign.id}
            title={campaign.postTitle ?? t("admin.common.none")}
            eyebrow={<span className="break-all">{campaign.postSlug ?? campaign.postId}</span>}
          >
            <div className="flex flex-wrap gap-2">
              <Badge variant={campaign.status === "dead" ? "destructive" : "secondary"}>
                {t(`admin.notifications.status${campaign.status}`)}
              </Badge>
              <Badge variant="outline">{t(`admin.notifications.source_${campaign.source}`)}</Badge>
            </div>
            <MobileDataField label={t("admin.notifications.deliveryCounts")}>
              <CountList
                ariaLabel={t("admin.notifications.deliveryCounts")}
                counts={campaign.deliveryCounts}
                keys={DELIVERY_KEYS}
                prefix="delivery"
                t={t}
              />
            </MobileDataField>
            <MobileDataField label={t("admin.notifications.attemptCounts")}>
              <div className="space-y-1.5">
                <CountList
                  ariaLabel={t("admin.notifications.attemptCounts")}
                  counts={campaign.attemptCounts}
                  keys={ATTEMPT_KEYS}
                  prefix="attempt"
                  t={t}
                />
                {campaign.suppressionCount > 0 ? (
                  <CountBadge
                    count={campaign.suppressionCount}
                    label={t("admin.notifications.suppressions")}
                    t={t}
                  />
                ) : null}
              </div>
            </MobileDataField>
            <MobileDataField
              label={t("admin.notifications.expansionCompleted")}
              valueClassName="text-muted-foreground"
            >
              {campaign.expansionCompletedAt
                ? formatDateTime(campaign.expansionCompletedAt)
                : t("admin.common.none")}
            </MobileDataField>
            <CampaignDiagnostics
              campaignId={campaign.id}
              cursorUserId={campaign.cursorUserId}
              t={t}
            />
            <ErrorDetails error={campaign.lastError} t={t} />
          </MobileDataCard>
        ))}
      />
      {campaigns.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("admin.notifications.empty")}</p>
      )}
    </div>
  );
}
