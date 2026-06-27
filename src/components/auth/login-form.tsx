"use client";

import { Mail, ShieldCheck } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  acceptFanLoginCodeRequest,
  canSubmitFanLoginCode,
  changeFanLoginCode,
  changeFanLoginEmail,
  INITIAL_FAN_LOGIN_FLOW,
  resetFanLoginRequestedEmail,
} from "@/components/auth/login-form-model";
import { TurnstileWidget, type TurnstileWidgetHandle } from "@/components/auth/turnstile-widget";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";
import { normalizeEmail, RAW_LOGIN_CODE_MAX_LENGTH } from "@/modules/auth/input-policy";

export function LoginForm({
  mode,
  turnstileSiteKey,
  loginCodeLength,
  loginCodePattern,
}: {
  mode: "fan" | "admin";
  turnstileSiteKey?: string;
  loginCodeLength: number;
  loginCodePattern: string;
}) {
  const t = useT();

  const [fanFlow, setFanFlow] = useState(INITIAL_FAN_LOGIN_FLOW);
  const { email, requestedEmail, code, codeSent } = fanFlow;
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);
  const [adminEmail, setAdminEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const codeRegex = useMemo(() => new RegExp(loginCodePattern), [loginCodePattern]);
  const codeComplete = canSubmitFanLoginCode(fanFlow, loginCodeLength, codeRegex);

  async function run(fn: () => Promise<void>) {
    setLoading(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("common.opFailed"));
    } finally {
      setLoading(false);
    }
  }

  if (mode === "admin") {
    return (
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-lg bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>{t("login.adminHint")}</span>
        </div>
        <div className="space-y-2">
          <Label htmlFor="admin-email">{t("login.adminEmail")}</Label>
          <Input
            id="admin-email"
            type="email"
            autoComplete="username"
            value={adminEmail}
            onChange={(event) => setAdminEmail(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="admin-password">{t("login.password")}</Label>
          <Input
            id="admin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <Button
          className="w-full"
          disabled={loading || !adminEmail || !password}
          onClick={() =>
            run(async () => {
              await api("/api/auth/admin/login", {
                method: "POST",
                body: { email: adminEmail, password },
              });
              window.location.assign("/admin");
            })
          }
        >
          {t("login.adminSignin")}
        </Button>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-lg bg-blue-50/60 px-3 py-3 text-sm text-blue-900 dark:bg-blue-950/20 dark:text-blue-100">
        <Mail className="mt-0.5 size-4 shrink-0" />
        <span>{t("login.passwordlessHint")}</span>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">{t("login.email")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          disabled={requestedEmail !== null}
          onChange={(event) =>
            setFanFlow((current) => changeFanLoginEmail(current, event.target.value))
          }
        />
        {requestedEmail && (
          <Button
            variant="link"
            size="sm"
            className="px-0"
            disabled={loading}
            onClick={() => {
              setFanFlow((current) => resetFanLoginRequestedEmail(current));
              setMessage(null);
              setTurnstileToken(null);
              turnstileRef.current?.reset();
            }}
          >
            {t("login.changeEmail")}
          </Button>
        )}
      </div>

      {codeSent && (
        <div className="space-y-2">
          <Label htmlFor="code">{t("login.code")}</Label>
          <Input
            id="code"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            maxLength={RAW_LOGIN_CODE_MAX_LENGTH}
            placeholder={t("login.codePlaceholder", { length: loginCodeLength })}
            value={code}
            onChange={(event) =>
              setFanFlow((current) => changeFanLoginCode(current, event.target.value))
            }
          />
          <p className="text-xs text-muted-foreground">{t("login.codeHint")}</p>
        </div>
      )}

      {turnstileSiteKey && (
        <TurnstileWidget
          ref={turnstileRef}
          siteKey={turnstileSiteKey}
          onToken={setTurnstileToken}
        />
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          className="w-full"
          variant={codeSent ? "outline" : "default"}
          disabled={loading || !email || (Boolean(turnstileSiteKey) && !turnstileToken)}
          onClick={() =>
            run(async () => {
              try {
                const targetEmail = requestedEmail ?? normalizeEmail(email);
                await api("/api/auth/request-code", {
                  method: "POST",
                  body: { email: targetEmail, turnstileToken: turnstileToken ?? undefined },
                });
                setFanFlow((current) => acceptFanLoginCodeRequest(current, targetEmail));
                setMessage(t("login.codeSent"));
              } finally {
                // Token is single-use, so reset it after every request attempt.
                if (turnstileSiteKey) {
                  turnstileRef.current?.reset();
                  setTurnstileToken(null);
                }
              }
            })
          }
        >
          {codeSent ? t("login.resend") : t("login.sendCode")}
        </Button>
        {codeSent && (
          <Button
            className="w-full"
            disabled={loading || !codeComplete}
            onClick={() =>
              run(async () => {
                await api("/api/auth/verify-code", {
                  method: "POST",
                  body: { email: requestedEmail, code },
                });
                window.location.assign("/me");
              })
            }
          >
            {t("login.signin")}
          </Button>
        )}
      </div>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
