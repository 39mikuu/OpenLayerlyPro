import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/modules/auth/session";
import { canEnterInside } from "@/modules/blog/access";
import { getBlogCopy } from "@/modules/blog/copy";
import { getT, resolveLocale } from "@/modules/i18n/server";
import { getPublicSiteInfo, isInitialized } from "@/modules/site";
import { PersonalBlogChrome } from "@/themes/blog/personal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function InsideLayout({ children }: { children: React.ReactNode }) {
  if (!getEnv().PERSONAL_BLOG_MODE) notFound();
  if (!(await isInitialized())) redirect("/admin/setup");
  const [site, user, t, locale] = await Promise.all([
    getPublicSiteInfo(),
    getCurrentUser(),
    getT(),
    resolveLocale(),
  ]);
  return (
    <PersonalBlogChrome
      inside
      t={t}
      copy={getBlogCopy(locale)}
      readerHasAccess={await canEnterInside(user)}
      view={{
        siteName: site.siteName,
        artistName: site.artistName,
        avatarUrl: null,
        logoUrl: null,
        socialLinks: [],
        isLoggedIn: Boolean(user),
        supporterWallEnabled: false,
        customFooterMarkup: "",
      }}
    >
      {children}
    </PersonalBlogChrome>
  );
}
