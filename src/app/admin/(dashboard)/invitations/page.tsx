import Link from "next/link";
import { notFound } from "next/navigation";

import { ReaderInvitationForm } from "@/components/admin/reader-invitation-form";
import { getEnv } from "@/lib/env";
import { requireAdmin } from "@/modules/auth/session";
import { getBlogCopy } from "@/modules/blog/copy";
import { listReaderInvitations } from "@/modules/blog/invitations";
import { getT, resolveLocale } from "@/modules/i18n/server";

import { revokeInvitation } from "./actions";

export default async function InvitationsPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; page?: string }>;
}) {
  if (!getEnv().PERSONAL_BLOG_MODE) notFound();
  await requireAdmin();
  const { email, page: pageParam } = await searchParams;
  const query = typeof email === "string" ? email.trim().slice(0, 254) : "";
  const page =
    typeof pageParam === "string" && /^\d{1,5}$/.test(pageParam)
      ? Math.max(1, Number(pageParam))
      : 1;
  const pageHref = (index: number) =>
    `/admin/invitations?${new URLSearchParams({
      ...(query && { email: query }),
      page: String(index),
    })}`;
  const [locale, t, invitations] = await Promise.all([
    resolveLocale(),
    getT(),
    listReaderInvitations(query, page),
  ]);
  const copy = getBlogCopy(locale);
  return (
    <section className="space-y-5">
      <h1 className="text-2xl font-bold">{copy.invite}</h1>
      <ReaderInvitationForm copy={copy} emailLabel={t("login.email")} />
      <form action="/admin/invitations" method="get" className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-sm">
          {t("login.email")}
          <input
            type="email"
            name="email"
            defaultValue={query}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2"
          />
        </label>
        <button
          type="submit"
          aria-label={copy.findInvite}
          className="rounded-md border px-3 py-2 text-sm"
        >
          {copy.findInvite}
        </button>
      </form>
      {invitations.items.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {invitations.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
            >
              <span className="min-w-0 break-all">{item.email}</span>
              <span>
                {item.revokedAt
                  ? copy.revoked
                  : item.redeemedAt
                    ? copy.active
                    : item.expiresAt <= new Date()
                      ? copy.expired
                      : copy.pending}
              </span>
              {!item.revokedAt && (
                <form action={revokeInvitation.bind(null, item.id)}>
                  <button type="submit" className="rounded-md border px-3 py-1">
                    {copy.revoke}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {(page > 1 || invitations.hasNext) && (
        <div className="flex gap-4 text-sm">
          {page > 1 && (
            <Link href={pageHref(page - 1)} className="underline">
              {copy.previous}
            </Link>
          )}
          {invitations.hasNext && (
            <Link href={pageHref(page + 1)} className="underline">
              {t("posts.nextPage")}
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
