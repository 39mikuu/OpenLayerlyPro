"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Notice } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";
import {
  getMembershipAdminActions,
  getMembershipDisplayState,
  type MembershipAdminAction,
  type MembershipDisplayState,
} from "@/modules/membership/admin-model";

type MembershipDetail = {
  membership: {
    id: string;
    status: "active" | "suspended" | "revoked";
    startsAt: string;
    endsAt: string;
    version: number;
  };
  tier: { name: string };
  userEmail: string;
  history: {
    id: string;
    action: string;
    actorType: string;
    actorId: string | null;
    reason: string | null;
    beforeJson: Record<string, unknown> | null;
    afterJson: Record<string, unknown> | null;
    createdAt: string;
  }[];
};

const STATE_KEYS: Record<MembershipDisplayState, string> = {
  active: "admin.memberships.active",
  scheduled: "admin.memberships.scheduled",
  expired: "admin.memberships.expired",
  suspended: "admin.memberships.suspended",
  revoked: "admin.memberships.revoked",
};

const ACTION_KEYS: Record<MembershipAdminAction, string> = {
  suspend: "admin.memberships.suspend",
  resume: "admin.memberships.resume",
  revoke: "admin.memberships.revoke",
  extend: "admin.memberships.extend",
};

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function snapshotSummary(value: Record<string, unknown> | null): string {
  if (!value) return "—";
  const status = typeof value.status === "string" ? value.status : "—";
  const endsAt =
    typeof value.endsAt === "string"
      ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value.endsAt))
      : "—";
  return `${status} · ${endsAt}`;
}

export function MembershipActions({ membershipId }: { membershipId: string }) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<MembershipDetail | null>(null);
  const [selectedAction, setSelectedAction] = useState<MembershipAdminAction | null>(null);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("30");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await api<MembershipDetail>(`/api/admin/memberships/${membershipId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.memberships.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [membershipId, t]);

  useEffect(() => {
    if (open) void loadDetail();
    if (!open) {
      setDetail(null);
      setSelectedAction(null);
      setReason("");
      setMessage(null);
      setError(null);
    }
  }, [loadDetail, membershipId, open]);

  const actions = detail ? getMembershipAdminActions(detail.membership) : [];
  const needsReason = selectedAction !== null && selectedAction !== "extend";
  const validDays = Number.isInteger(Number(days)) && Number(days) > 0;
  const canConfirm =
    selectedAction !== null &&
    !loading &&
    (selectedAction === "extend" ? validDays : reason.trim().length > 0);

  async function submitAction() {
    if (!detail || !selectedAction || !canConfirm) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      await api(`/api/admin/memberships/${membershipId}/${selectedAction}`, {
        method: "POST",
        body:
          selectedAction === "extend"
            ? { days: Number(days), expectedVersion: detail.membership.version }
            : { reason: reason.trim(), expectedVersion: detail.membership.version },
      });
      setSelectedAction(null);
      setReason("");
      setMessage(t("admin.memberships.actionSucceeded"));
      await loadDetail();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.memberships.actionFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        {t("admin.memberships.details")}
      </DialogTrigger>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        closeLabel={t("admin.common.close")}
      >
        <DialogHeader>
          <DialogTitle>{t("admin.memberships.detailsTitle")}</DialogTitle>
          <DialogDescription>
            {detail
              ? t("admin.memberships.detailsDescription", {
                  email: detail.userEmail,
                  tier: detail.tier.name,
                })
              : t("admin.memberships.loading")}
          </DialogDescription>
        </DialogHeader>

        {detail && (
          <div className="space-y-5">
            <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">
                  {t("admin.memberships.currentState")}
                </p>
                <Badge className="mt-1">
                  {t(STATE_KEYS[getMembershipDisplayState(detail.membership)])}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("admin.memberships.version")}</p>
                <p className="mt-1 font-medium">{detail.membership.version}</p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs text-muted-foreground">{t("admin.memberships.validity")}</p>
                <p className="mt-1">
                  {formatTimestamp(detail.membership.startsAt)} –{" "}
                  {formatTimestamp(detail.membership.endsAt)}
                </p>
              </div>
            </div>

            <section className="space-y-3">
              <h3 className="font-medium">{t("admin.memberships.actions")}</h3>
              {actions.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {actions.map((action) => (
                    <Button
                      key={action}
                      type="button"
                      size="sm"
                      variant={action === "revoke" ? "destructive" : "outline"}
                      onClick={() => {
                        setSelectedAction(action);
                        setReason("");
                        setError(null);
                        setMessage(null);
                      }}
                    >
                      {t(ACTION_KEYS[action])}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t("admin.memberships.noActions")}</p>
              )}

              {selectedAction && (
                <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                  <p className="font-medium">
                    {t("admin.memberships.confirmTitle", {
                      action: t(ACTION_KEYS[selectedAction]),
                    })}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {selectedAction === "extend"
                      ? t("admin.memberships.confirmExtendSummary", { days: Number(days) || 0 })
                      : t("admin.memberships.confirmSummary", {
                          action: t(ACTION_KEYS[selectedAction]),
                        })}
                  </p>
                  {needsReason ? (
                    <div className="space-y-1">
                      <Label htmlFor={`membership-reason-${membershipId}`}>
                        {t("admin.memberships.reason")}
                      </Label>
                      <Input
                        id={`membership-reason-${membershipId}`}
                        value={reason}
                        maxLength={500}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder={t("admin.memberships.reasonPlaceholder")}
                      />
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <Label htmlFor={`membership-days-${membershipId}`}>
                        {t("admin.memberships.extendDays")}
                      </Label>
                      <Input
                        id={`membership-days-${membershipId}`}
                        type="number"
                        min={1}
                        step={1}
                        value={days}
                        onChange={(event) => setDays(event.target.value)}
                      />
                    </div>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={loading}
                      onClick={() => setSelectedAction(null)}
                    >
                      {t("admin.memberships.cancel")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={selectedAction === "revoke" ? "destructive" : "default"}
                      disabled={!canConfirm}
                      onClick={submitAction}
                    >
                      {t("admin.memberships.confirmAction")}
                    </Button>
                  </div>
                </div>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="font-medium">{t("admin.memberships.history")}</h3>
              {detail.history.length > 0 ? (
                <div className="space-y-2">
                  {detail.history.map((event) => (
                    <div key={event.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          {t(`admin.memberships.historyAction${event.action}`)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatTimestamp(event.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("admin.memberships.historyActor", {
                          actor: t(`admin.memberships.actor${event.actorType}`),
                        })}
                      </p>
                      {event.reason && <p className="mt-2">{event.reason}</p>}
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t("admin.memberships.historySnapshot", {
                          before: snapshotSummary(event.beforeJson),
                          after: snapshotSummary(event.afterJson),
                        })}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("admin.memberships.historyEmpty")}
                </p>
              )}
            </section>
          </div>
        )}

        {message && <Notice variant="success">{message}</Notice>}
        {error && <Notice variant="error">{error}</Notice>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {t("admin.memberships.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
