"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmActionButton } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

type SessionView = {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};

type HistoryView = {
  id: string;
  action: string;
  actorType: string;
  createdAt: string;
};

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function AdminAccountManager({
  email,
  sessions,
  history,
}: {
  email: string;
  sessions: SessionView[];
  history: HistoryView[];
}) {
  const router = useRouter();
  const t = useT();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [newEmail, setNewEmail] = useState(email);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);

  async function runConfirmed(action: () => Promise<void>) {
    setLoading(true);
    setMessage(null);
    try {
      await action();
      router.refresh();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : t("admin.common.operationFailed");
      setMessage(errorMessage);
      throw new Error(errorMessage);
    } finally {
      setLoading(false);
    }
  }

  async function changePassword() {
    await runConfirmed(async () => {
      await api("/api/admin/account/password", {
        method: "POST",
        body: { currentPassword, newPassword },
      });
      setCurrentPassword("");
      setNewPassword("");
      setMessage(t("admin.account.passwordChanged"));
    });
  }

  async function changeEmail() {
    await runConfirmed(async () => {
      await api("/api/admin/account/email", {
        method: "POST",
        body: { currentPassword: emailPassword, newEmail },
      });
      setEmailPassword("");
      setMessage(t("admin.account.emailChanged"));
    });
  }

  async function revokeSessionConfirmed(session: SessionView) {
    await runConfirmed(async () => {
      const result = await api<{ current: boolean }>(`/api/admin/account/sessions/${session.id}`, {
        method: "DELETE",
      });
      if (result.current) {
        window.location.href = "/login?admin=1";
        return;
      }
      setMessage(t("admin.account.sessionRevoked"));
    });
  }

  return (
    <div className="space-y-6">
      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("admin.account.changePassword")}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (loading || !currentPassword || newPassword.length < 8) return;
                setPasswordDialogOpen(true);
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="current-password">{t("admin.account.currentPassword")}</Label>
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-password">{t("admin.account.newPassword")}</Label>
                <Input
                  id="new-password"
                  type="password"
                  minLength={8}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("admin.account.passwordHint")}</p>
              </div>
              <ConfirmActionButton
                actionLabel={t("admin.account.updatePassword")}
                cancelLabel={t("admin.common.cancel")}
                closeLabel={t("admin.common.close")}
                confirmLabel={t("admin.account.updatePassword")}
                confirmVariant="default"
                description={t("admin.account.passwordDialogDescription")}
                disabled={loading || !currentPassword || newPassword.length < 8}
                errorFallback={t("admin.common.operationFailed")}
                loadingLabel={t("admin.common.saving")}
                onOpenChange={setPasswordDialogOpen}
                open={passwordDialogOpen}
                size="default"
                title={t("admin.account.passwordDialogTitle")}
                triggerOpensDialog={false}
                triggerType="submit"
                onConfirm={changePassword}
              />
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("admin.account.changeEmail")}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (loading || !emailPassword || !newEmail) return;
                setEmailDialogOpen(true);
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="new-email">{t("admin.account.newEmail")}</Label>
                <Input
                  id="new-email"
                  type="email"
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="email-password">{t("admin.account.currentPassword")}</Label>
                <Input
                  id="email-password"
                  type="password"
                  autoComplete="current-password"
                  value={emailPassword}
                  onChange={(event) => setEmailPassword(event.target.value)}
                />
              </div>
              <ConfirmActionButton
                actionLabel={t("admin.account.updateEmail")}
                cancelLabel={t("admin.common.cancel")}
                closeLabel={t("admin.common.close")}
                confirmLabel={t("admin.account.updateEmail")}
                confirmVariant="default"
                description={t("admin.account.emailDialogDescription", { email: newEmail })}
                disabled={loading || !emailPassword || !newEmail}
                errorFallback={t("admin.common.operationFailed")}
                loadingLabel={t("admin.common.saving")}
                onOpenChange={setEmailDialogOpen}
                open={emailDialogOpen}
                size="default"
                title={t("admin.account.emailDialogTitle")}
                triggerOpensDialog={false}
                triggerType="submit"
                onConfirm={changeEmail}
              />
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <CardTitle>{t("admin.account.sessions")}</CardTitle>
          <ConfirmActionButton
            actionLabel={t("admin.account.revokeOthers")}
            cancelLabel={t("admin.common.cancel")}
            closeLabel={t("admin.common.close")}
            confirmLabel={t("admin.account.revokeOthers")}
            description={t("admin.account.revokeOthersDialogDescription")}
            disabled={loading || sessions.filter((session) => !session.current).length === 0}
            errorFallback={t("admin.common.operationFailed")}
            loadingLabel={t("admin.account.revoking")}
            title={t("admin.account.revokeOthersDialogTitle")}
            variant="outline"
            onConfirm={() =>
              runConfirmed(async () => {
                await api("/api/admin/account/sessions/revoke-others", { method: "POST" });
                setMessage(t("admin.account.otherSessionsRevoked"));
              })
            }
          />
        </CardHeader>
        <CardContent className="space-y-3">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 text-sm">
                <div className="flex items-center gap-2">
                  <span className="truncate">
                    {session.userAgent || t("admin.account.unknownDevice")}
                  </span>
                  {session.current && <Badge>{t("admin.account.currentSession")}</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {session.ip || t("admin.account.unknownIp")} ·{" "}
                  {t("admin.account.createdAt", { date: formatDateTime(session.createdAt) })} ·{" "}
                  {t("admin.account.expiresAt", { date: formatDateTime(session.expiresAt) })}
                </p>
              </div>
              <ConfirmActionButton
                actionLabel={t("admin.account.revokeSession")}
                cancelLabel={t("admin.common.cancel")}
                closeLabel={t("admin.common.close")}
                confirmLabel={t("admin.account.revokeSession")}
                description={
                  session.current
                    ? t("admin.account.revokeCurrentDialogDescription")
                    : t("admin.account.revokeSessionDialogDescription")
                }
                disabled={loading}
                errorFallback={t("admin.common.operationFailed")}
                loadingLabel={t("admin.account.revoking")}
                title={
                  session.current
                    ? t("admin.account.revokeCurrentDialogTitle")
                    : t("admin.account.revokeSessionDialogTitle")
                }
                variant={session.current ? "destructive" : "outline"}
                onConfirm={() => revokeSessionConfirmed(session)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("admin.account.history")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {history.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("admin.account.noHistory")}</p>
          )}
          {history.map((event) => (
            <div key={event.id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{t(`admin.account.action${event.action}`)}</span>
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(event.createdAt)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("admin.account.actor", {
                  actor:
                    event.actorType === "system"
                      ? t("admin.account.actorSystem")
                      : t("admin.account.actorAdmin"),
                })}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
