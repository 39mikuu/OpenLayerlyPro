import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { getEnv } from "@/lib/env";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";
import { getT } from "@/modules/i18n/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const STATUSES = ["expired", "replayed", "invalid"] as const;
type ResultStatus = (typeof STATUSES)[number];

function normalizeStatus(value: string | undefined): ResultStatus {
  return STATUSES.includes(value as ResultStatus) ? (value as ResultStatus) : "invalid";
}

/**
 * Magic Link 确认失败后的无 token 结果页。成功路径直接 303 到登录后目标页,
 * 不经过这里。
 */
export default async function MagicLinkResultPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const [params, t] = await Promise.all([searchParams, getT()]);
  const status = normalizeStatus(params.status);
  // Keep an APP_URL path prefix on the login link (subpath deployments).
  const loginHref = buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), "/login");

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-12">
      <section className="rounded-xl border bg-card p-6 shadow-sm">
        <p className="text-sm font-medium text-muted-foreground">{t("magicLink.eyebrow")}</p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">
          {t(`magicLink.resultTitle${status}`)}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {t(`magicLink.resultDescription${status}`)}
        </p>
        <Button className="mt-6" asChild>
          <Link href={loginHref}>{t("magicLink.backToLogin")}</Link>
        </Button>
      </section>
    </main>
  );
}
