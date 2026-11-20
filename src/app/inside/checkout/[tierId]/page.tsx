import type { Metadata } from "next";
import { notFound } from "next/navigation";

import ReaderPage from "@/app/(site)/checkout/[tierId]/page";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function InsidePage(props: Parameters<typeof ReaderPage>[0]) {
  if (!getEnv().PERSONAL_BLOG_MODE) notFound();
  return ReaderPage(props);
}
