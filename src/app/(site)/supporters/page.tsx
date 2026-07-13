import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { buildListPageSeoCopy, buildSiteMetadata } from "@/modules/content/seo";
import { getT } from "@/modules/i18n/server";
import { getSupporterWallViewModel } from "@/modules/supporter-wall";
import { getActiveTheme } from "@/modules/theme";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return buildSiteMetadata("/supporters", buildListPageSeoCopy("supporters"));
}

export default async function SupportersPage() {
  const [theme, t, view] = await Promise.all([
    getActiveTheme(),
    getT(),
    getSupporterWallViewModel(),
  ]);
  if (!view) notFound();

  const SupporterWall = theme.components.SupporterWall;
  return <SupporterWall view={view} t={t} />;
}
