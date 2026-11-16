import type { Metadata } from "next";
import { notFound } from "next/navigation";

import ReaderPage from "@/app/(site)/me/page";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function InsidePage() {
  if (!getEnv().PERSONAL_BLOG_MODE) notFound();
  return ReaderPage();
}
