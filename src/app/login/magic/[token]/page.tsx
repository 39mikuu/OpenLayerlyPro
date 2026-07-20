import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { getEnv } from "@/lib/env";
import { verifyMagicLinkToken } from "@/modules/auth/magic-link";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";
import { getT } from "@/modules/i18n/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * token 只含 URL 安全字符,正常情况下无需解码;这里兜底处理个别客户端会
 * 对路径段做百分号编码的情况,坏序列直接按原文验证(随后判为 invalid)。
 */
function safeDecodeTokenSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 邮件里的 GET 链接只落在这个确认页:验证 token 但绝不消费,邮件客户端的
 * prefetch 无法完成登录。只有用户显式提交下面的 POST 表单才会消费 token。
 */
export default async function MagicLinkConfirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const [{ token: rawToken }, t] = await Promise.all([params, getT()]);
  const token = safeDecodeTokenSegment(rawToken);
  const verification = await verifyMagicLinkToken(token);
  const valid = verification.status === "valid";
  const invalidStatus = verification.status === "valid" ? "invalid" : verification.status;
  // Absolute URLs via buildPublicUrl keep an APP_URL path prefix; a root-
  // relative action or href would escape a /base-scoped reverse proxy.
  const publicBaseUrl = getPublicBaseUrl(getEnv().APP_URL);
  const confirmAction = buildPublicUrl(publicBaseUrl, "/api/auth/magic-link/confirm");
  const loginHref = buildPublicUrl(publicBaseUrl, "/login");

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-12">
      <section className="rounded-xl border bg-card p-6 shadow-sm">
        <p className="text-sm font-medium text-muted-foreground">{t("magicLink.eyebrow")}</p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">
          {valid ? t("magicLink.confirmTitle") : t(`magicLink.resultTitle${invalidStatus}`)}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {valid
            ? t("magicLink.confirmDescription")
            : t(`magicLink.resultDescription${invalidStatus}`)}
        </p>
        {valid ? (
          <form className="mt-6" action={confirmAction} method="post">
            <input type="hidden" name="token" value={token} />
            <Button type="submit">{t("magicLink.confirmAction")}</Button>
          </form>
        ) : (
          <Button className="mt-6" asChild>
            <Link href={loginHref}>{t("magicLink.backToLogin")}</Link>
          </Button>
        )}
      </section>
    </main>
  );
}
