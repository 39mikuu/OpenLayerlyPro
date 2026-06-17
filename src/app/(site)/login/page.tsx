import { redirect } from "next/navigation";

import { getCurrentUser } from "@/modules/auth/session";
import { getTurnstileConfig } from "@/modules/config";
import { getT } from "@/modules/i18n/server";
import { getActiveTheme } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ admin?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/me");
  const { admin } = await searchParams;
  // site key 在服务端运行时读取后下发，避免依赖构建期内联（Docker 镜像构建时无 .env）
  const [turnstile, theme, t] = await Promise.all([getTurnstileConfig(), getActiveTheme(), getT()]);
  const Login = theme.components.Login;
  return (
    <Login
      t={t}
      view={{
        mode: admin === "1" ? "admin" : "fan",
        turnstileSiteKey: turnstile.enabled ? (turnstile.siteKey ?? undefined) : undefined,
      }}
    />
  );
}
