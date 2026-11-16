import type { Metadata } from "next";
import { notFound } from "next/navigation";

import LoginPage from "@/app/(site)/login/page";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function InsideLoginPage({ searchParams }: Parameters<typeof LoginPage>[0]) {
  if (!getEnv().PERSONAL_BLOG_MODE) notFound();
  return LoginPage({
    searchParams: searchParams.then(({ next, oauth_error }) => ({ next, oauth_error })),
  });
}
