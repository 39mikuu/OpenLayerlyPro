"use client";

import { Mail, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  acceptFanLoginCodeRequest,
  acceptFanLoginLinkRequest,
  canSubmitFanLoginCode,
  changeFanLoginCode,
  changeFanLoginEmail,
  INITIAL_FAN_LOGIN_FLOW,
  normalizeOAuthErrorCode,
  resetFanLoginRequestedEmail,
} from "@/components/auth/login-form-model";
import { TurnstileWidget, type TurnstileWidgetHandle } from "@/components/auth/turnstile-widget";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";
import { normalizeEmail, RAW_LOGIN_CODE_MAX_LENGTH } from "@/modules/auth/input-policy";
import { normalizeMagicLinkRedirectPath, withSiteBasePath } from "@/modules/auth/redirect-path";

export function LoginForm({
  mode,
  turnstileSiteKey,
  loginCodeLength,
  loginCodePattern,
  magicLinkEnabled,
  magicLinkNext,
  googleOAuthEnabled,
  githubOAuthEnabled,
  oauthNext,
  oauthError,
  oauthBasePath,
}: {
  mode: "fan" | "admin";
  turnstileSiteKey?: string;
  loginCodeLength: number;
  loginCodePattern: string;
  magicLinkEnabled?: boolean;
  magicLinkNext?: string;
  googleOAuthEnabled?: boolean;
  githubOAuthEnabled?: boolean;
  oauthNext?: string;
  oauthError?: string | null;
  oauthBasePath?: string;
}) {
  const t = useT();

  const [fanFlow, setFanFlow] = useState(INITIAL_FAN_LOGIN_FLOW);
  const { email, requestedEmail, code, codeSent, linkSent } = fanFlow;
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const [adminEmail, setAdminEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const codeRegex = useMemo(() => new RegExp(loginCodePattern), [loginCodePattern]);
  const codeComplete = canSubmitFanLoginCode(fanFlow, loginCodeLength, codeRegex);
  const normalizedOAuthError = normalizeOAuthErrorCode(oauthError);
  const postLoginPath = normalizeMagicLinkRedirectPath(magicLinkNext ?? oauthNext) ?? "/me";

  useEffect(() => {
    if (codeSent) codeInputRef.current?.focus();
  }, [codeSent]);

  async function run(fn: () => Promise<void>, progress: string) {
    setLoading(true);
    setStatus(progress);
    setError("");
    try {
      await fn();
    } catch (err) {
      setStatus("");
      setError(err instanceof Error ? err.message : t("common.opFailed"));
    } finally {
      setLoading(false);
    }
  }

  function sendCode() {
    void run(async () => {
      try {
        const targetEmail = requestedEmail ?? normalizeEmail(email);
        await api(withSiteBasePath("/api/auth/request-code", oauthBasePath), {
          method: "POST",
          body: { email: targetEmail, turnstileToken: turnstileToken ?? undefined },
        });
        setFanFlow((current) => acceptFanLoginCodeRequest(current, targetEmail));
        setStatus(t("login.codeSent"));
      } finally {
        if (turnstileSiteKey) {
          turnstileRef.current?.reset();
          setTurnstileToken(null);
        }
      }
    }, t("login.sendingCode"));
  }

  function sendMagicLink() {
    void run(async () => {
      try {
        const targetEmail = requestedEmail ?? normalizeEmail(email);
        await api(withSiteBasePath("/api/auth/magic-link/request", oauthBasePath), {
          method: "POST",
          body: {
            email: targetEmail,
            turnstileToken: turnstileToken ?? undefined,
            next: postLoginPath,
          },
        });
        setFanFlow((current) => acceptFanLoginLinkRequest(current, targetEmail));
        setStatus(t("login.magicLinkSent"));
      } finally {
        if (turnstileSiteKey) {
          turnstileRef.current?.reset();
          setTurnstileToken(null);
        }
      }
    }, t("login.sendingMagicLink"));
  }

  function verifyCode() {
    void run(async () => {
      await api(withSiteBasePath("/api/auth/verify-code", oauthBasePath), {
        method: "POST",
        body: { email: requestedEmail, code },
      });
      window.location.assign(withSiteBasePath(postLoginPath, oauthBasePath));
    }, t("login.verifyingCode"));
  }

  if (mode === "admin") {
    return (
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-lg bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>{t("login.adminHint")}</span>
        </div>
        <form
          className="space-y-5"
          aria-busy={loading}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api(withSiteBasePath("/api/auth/admin/login", oauthBasePath), {
                method: "POST",
                body: { email: adminEmail, password },
              });
              window.location.assign(withSiteBasePath("/admin", oauthBasePath));
            }, t("login.signingIn"));
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="admin-email">{t("login.adminEmail")}</Label>
            <Input
              id="admin-email"
              type="email"
              autoComplete="username"
              required
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
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading || !adminEmail || !password}>
            {t("login.adminSignin")}
          </Button>
        </form>
        <p
          role="status"
          aria-live="polite"
          className={status ? "text-sm text-muted-foreground" : "sr-only"}
        >
          {status}
        </p>
        <p role="alert" className={error ? "text-sm text-destructive" : "sr-only"}>
          {error}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-lg bg-blue-50/60 px-3 py-3 text-sm text-blue-900 dark:bg-blue-950/20 dark:text-blue-100">
        <Mail className="mt-0.5 size-4 shrink-0" />
        <span>{magicLinkEnabled ? t("login.magicLinkHint") : t("login.passwordlessHint")}</span>
      </div>

      {normalizedOAuthError && (
        <p role="alert" className="text-sm text-destructive">
          {t(`login.oauthError.${normalizedOAuthError}` as "login.oauthError.failed")}
        </p>
      )}

      {(googleOAuthEnabled || githubOAuthEnabled) && (
        <div className="space-y-2">
          {googleOAuthEnabled && (
            <Button className="w-full" variant="outline" asChild>
              <a
                href={
                  postLoginPath !== "/me"
                    ? `${withSiteBasePath("/api/auth/oauth/google/start", oauthBasePath)}?next=${encodeURIComponent(postLoginPath)}`
                    : withSiteBasePath("/api/auth/oauth/google/start", oauthBasePath)
                }
              >
                {t("login.continueWithGoogle")}
              </a>
            </Button>
          )}
          {githubOAuthEnabled && (
            <Button className="w-full" variant="outline" asChild>
              <a
                href={
                  postLoginPath !== "/me"
                    ? `${withSiteBasePath("/api/auth/oauth/github/start", oauthBasePath)}?next=${encodeURIComponent(postLoginPath)}`
                    : withSiteBasePath("/api/auth/oauth/github/start", oauthBasePath)
                }
              >
                {t("login.continueWithGithub")}
              </a>
            </Button>
          )}
          <div className="relative py-1 text-center text-xs text-muted-foreground">
            <span>{t("login.orEmail")}</span>
          </div>
        </div>
      )}

      <form
        className="space-y-5"
        aria-busy={loading}
        onSubmit={(event) => {
          event.preventDefault();
          if (codeSent) {
            if (codeComplete && !loading) verifyCode();
          } else if (email && !loading && (!turnstileSiteKey || turnstileToken)) {
            sendCode();
          }
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="email">{t("login.email")}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
            value={email}
            disabled={requestedEmail !== null}
            onChange={(event) =>
              setFanFlow((current) => changeFanLoginEmail(current, event.target.value))
            }
          />
          {requestedEmail && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="px-0"
              disabled={loading}
              onClick={() => {
                setFanFlow((current) => resetFanLoginRequestedEmail(current));
                setStatus("");
                setError("");
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
              ref={codeInputRef}
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

        {magicLinkEnabled && (
          <Button
            type="button"
            className="w-full"
            variant="outline"
            disabled={loading || !email || (Boolean(turnstileSiteKey) && !turnstileToken)}
            onClick={sendMagicLink}
          >
            {linkSent ? t("login.magicLinkResend") : t("login.sendMagicLink")}
          </Button>
        )}

        {codeSent && (
          <Button
            type="button"
            className="w-full"
            variant="outline"
            disabled={loading || !email || (Boolean(turnstileSiteKey) && !turnstileToken)}
            onClick={sendCode}
          >
            {t("login.resend")}
          </Button>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={
            loading ||
            (codeSent ? !codeComplete : !email || (Boolean(turnstileSiteKey) && !turnstileToken))
          }
        >
          {codeSent ? t("login.signin") : t("login.sendCode")}
        </Button>
      </form>

      <p
        role="status"
        aria-live="polite"
        className={status ? "text-sm text-muted-foreground" : "sr-only"}
      >
        {status}
      </p>
      <p role="alert" className={error ? "text-sm text-destructive" : "sr-only"}>
        {error}
      </p>
    </div>
  );
}
