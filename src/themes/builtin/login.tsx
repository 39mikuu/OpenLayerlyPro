import { LoginForm } from "@/components/auth/login-form";
import type { Translate } from "@/modules/i18n";
import type { LoginView } from "@/modules/theme/types";

export function Login({ view, t }: { view: LoginView; t: Translate }) {
  return (
    <div className="mx-auto max-w-md py-4 sm:py-8">
      <header className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">
          {t(view.mode === "admin" ? "login.adminHeading" : "login.heading")}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t(view.mode === "admin" ? "login.adminSubtitle" : "login.subtitle")}
        </p>
      </header>

      <div className="mt-6 rounded-xl border bg-card p-5 text-card-foreground shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
        <LoginForm
          mode={view.mode}
          turnstileSiteKey={view.turnstileSiteKey}
          loginCodeLength={view.loginCodeLength}
          loginCodePattern={view.loginCodePattern}
        />
      </div>

      {view.mode === "fan" && (
        <p className="mt-4 text-center text-xs text-muted-foreground">{t("login.emailPrivacy")}</p>
      )}
    </div>
  );
}
