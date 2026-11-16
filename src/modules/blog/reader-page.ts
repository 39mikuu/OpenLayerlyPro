import { notFound, redirect } from "next/navigation";

import { getEnv } from "@/lib/env";
import { getOAuthApiBasePath } from "@/modules/auth/oauth";
import { withSiteBasePath } from "@/modules/auth/redirect-path";
import { getCurrentUser } from "@/modules/auth/session";

import { canEnterInside } from "./access";

export async function requireInsidePage(next: string, needsInvitation = true) {
  if (!getEnv().PERSONAL_BLOG_MODE) notFound();
  const user = await getCurrentUser();
  if (!user) {
    const login = withSiteBasePath("/inside/login", getOAuthApiBasePath());
    redirect(`${login}?next=${encodeURIComponent(next)}`);
  }
  if (needsInvitation && !(await canEnterInside(user))) notFound();
  return user;
}
