import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getEnv } from "@/lib/env";
import { buildListPageSeoCopy, buildSiteMetadata } from "@/modules/content/seo";
import { getT } from "@/modules/i18n/server";
import { getSupporterWallViewModel } from "@/modules/supporter-wall";
import { getActiveTheme } from "@/modules/theme";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  if (getEnv().PERSONAL_BLOG_MODE) return { robots: { index: false, follow: false } };
  return buildSiteMetadata("/supporters", buildListPageSeoCopy("supporters"));
}

export default async function SupportersPage() {
  if (getEnv().PERSONAL_BLOG_MODE) notFound();
  const [theme, t, view] = await Promise.all([
    getActiveTheme(),
    getT(),
    getSupporterWallViewModel(),
  ]);
  if (!view) notFound();

  const SupporterWall = theme.components.SupporterWall;
  return <SupporterWall view={view} t={t} />;
}
