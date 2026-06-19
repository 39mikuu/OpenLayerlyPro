"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

  async function run(action: () => Promise<void>) {
    setLoading(true);
    setMessage(null);
    try {
      await action();
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (!confirm(t("admin.account.confirmPasswordChange"))) return;
    await run(async () => {
      await api("/api/admin/account/password", {
        method: "POST",
        body: { currentPassword, newPassword },
      });
      setCurrentPassword("");
      setNewPassword("");
      setMessage(t("admin.account.passwordChanged"));
    });
  }

  async function changeEmail(event: FormEvent) {
    event.preventDefault();
    if (!confirm(t("admin.account.confirmEmailChange"))) return;
    await run(async () => {
      await api("/api/admin/account/email", {
        method: "POST",
        body: { currentPassword: emailPassword, newEmail },
      });
      setEmailPassword("");
      setMessage(t("admin.account.emailChanged"));
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
            <form className="space-y-4" onSubmit={changePassword}>
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
              <Button
                type="submit"
                disabled={loading || !currentPassword || newPassword.length < 8}
              >
                {t("admin.account.updatePassword")}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("admin.account.changeEmail")}</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={changeEmail}>
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
              <Button type="submit" disabled={loading || !emailPassword || !newEmail}>
                {t("admin.account.updateEmail")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <CardTitle>{t("admin.account.sessions")}</CardTitle>
          <Button
            variant="outline"
            disabled={loading || sessions.filter((session) => !session.current).length === 0}
            onClick={() => {
              if (!confirm(t("admin.account.confirmRevokeOthers"))) return;
              void run(async () => {
                await api("/api/admin/account/sessions/revoke-others", { method: "POST" });
                setMessage(t("admin.account.otherSessionsRevoked"));
              });
            }}
          >
            {t("admin.account.revokeOthers")}
          </Button>
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
              <Button
                size="sm"
                variant={session.current ? "destructive" : "outline"}
                disabled={loading}
                onClick={() => {
                  if (
                    !confirm(
                      session.current
                        ? t("admin.account.confirmRevokeCurrent")
                        : t("admin.account.confirmRevokeSession"),
                    )
                  ) {
                    return;
                  }
                  void run(async () => {
                    const result = await api<{ current: boolean }>(
                      `/api/admin/account/sessions/${session.id}`,
                      { method: "DELETE" },
                    );
                    if (result.current) {
                      window.location.href = "/login?admin=1";
                      return;
                    }
                    setMessage(t("admin.account.sessionRevoked"));
                  });
                }}
              >
                {t("admin.account.revokeSession")}
              </Button>
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
