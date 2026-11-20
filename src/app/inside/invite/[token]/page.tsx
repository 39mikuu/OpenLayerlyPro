import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { getEnv } from "@/lib/env";
import { getOAuthApiBasePath } from "@/modules/auth/oauth";
import { withSiteBasePath } from "@/modules/auth/redirect-path";
import { getCurrentUser } from "@/modules/auth/session";
import { getBlogCopy } from "@/modules/blog/copy";
import { isReaderInvitationToken, redeemReaderInvitation } from "@/modules/blog/invitations";
import { resolveLocale } from "@/modules/i18n/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ invalid?: string }>;
}) {
  const { token } = await params;
  if (!getEnv().PERSONAL_BLOG_MODE || !isReaderInvitationToken(token)) notFound();
  const [user, locale, query] = await Promise.all([
    getCurrentUser(),
    resolveLocale(),
    searchParams,
  ]);
  const copy = getBlogCopy(locale);
  const basePath = getOAuthApiBasePath();
  const invitePath = `/inside/invite/${token}`;
  const loginPath = `${withSiteBasePath("/inside/login", basePath)}?next=${encodeURIComponent(invitePath)}`;
  async function accept() {
    "use server";
    if (!getEnv().PERSONAL_BLOG_MODE) notFound();
    const current = await getCurrentUser();
    if (!current) redirect(loginPath);
    if (!(await redeemReaderInvitation(token, current))) {
      redirect(`${withSiteBasePath(invitePath, basePath)}?invalid=1`);
    }
    redirect(withSiteBasePath("/inside", basePath));
  }

  return (
    <section className="mx-auto max-w-md space-y-5 rounded-xl border bg-card p-5 sm:p-7">
      <h1 className="text-2xl font-bold">{copy.inviteHeading}</h1>
      <p className="text-sm leading-6 text-muted-foreground">{copy.inviteHint}</p>
      {query.invalid === "1" && (
        <p role="alert" className="text-sm text-destructive">
          {copy.invalidInvite}
        </p>
      )}
      {user ? (
        <form action={accept} className="space-y-3">
          <p className="break-all text-sm">{user.email}</p>
          <button
            type="submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {copy.accept}
          </button>
        </form>
      ) : (
        <a
          href={loginPath}
          className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          {copy.signIn}
        </a>
      )}
    </section>
  );
}
