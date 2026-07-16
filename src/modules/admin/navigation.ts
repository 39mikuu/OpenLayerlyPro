export type AdminNavGroupKey =
  | "overview"
  | "content"
  | "members"
  | "payments"
  | "operations"
  | "site"
  | "system";

export type AdminNavItemKey =
  | "overview"
  | "posts"
  | "taxonomy"
  | "translations"
  | "files"
  | "users"
  | "memberships"
  | "tiers"
  | "paymentReviews"
  | "paymentMethods"
  | "downloads"
  | "notifications"
  | "supporterWall"
  | "tasks"
  | "site"
  | "settings"
  | "system"
  | "account";

export type AdminNavItem = {
  key: AdminNavItemKey;
  href: string;
  labelKey: string;
};

export type AdminNavGroup = {
  key: AdminNavGroupKey;
  labelKey: string;
  items: AdminNavItem[];
};

export const adminNavGroups: AdminNavGroup[] = [
  {
    key: "overview",
    labelKey: "admin.navGroups.overview",
    items: [{ href: "/admin", key: "overview", labelKey: "admin.nav.overview" }],
  },
  {
    key: "content",
    labelKey: "admin.navGroups.content",
    items: [
      { href: "/admin/posts", key: "posts", labelKey: "admin.nav.posts" },
      { href: "/admin/taxonomy", key: "taxonomy", labelKey: "admin.nav.taxonomy" },
      { href: "/admin/translations", key: "translations", labelKey: "admin.nav.translations" },
      { href: "/admin/files", key: "files", labelKey: "admin.nav.files" },
    ],
  },
  {
    key: "members",
    labelKey: "admin.navGroups.members",
    items: [
      { href: "/admin/users", key: "users", labelKey: "admin.nav.users" },
      { href: "/admin/memberships", key: "memberships", labelKey: "admin.nav.memberships" },
      { href: "/admin/tiers", key: "tiers", labelKey: "admin.nav.tiers" },
    ],
  },
  {
    key: "payments",
    labelKey: "admin.navGroups.payments",
    items: [
      {
        href: "/admin/payments/reviews",
        key: "paymentReviews",
        labelKey: "admin.nav.paymentReviews",
      },
      {
        href: "/admin/payments/methods",
        key: "paymentMethods",
        labelKey: "admin.nav.paymentMethods",
      },
    ],
  },
  {
    key: "operations",
    labelKey: "admin.navGroups.operations",
    items: [
      { href: "/admin/downloads", key: "downloads", labelKey: "admin.nav.downloads" },
      { href: "/admin/notifications", key: "notifications", labelKey: "admin.nav.notifications" },
      {
        href: "/admin/supporter-wall",
        key: "supporterWall",
        labelKey: "admin.nav.supporterWall",
      },
      { href: "/admin/tasks", key: "tasks", labelKey: "admin.nav.tasks" },
    ],
  },
  {
    key: "site",
    labelKey: "admin.navGroups.site",
    items: [
      { href: "/admin/site", key: "site", labelKey: "admin.nav.site" },
      { href: "/admin/settings", key: "settings", labelKey: "admin.nav.settings" },
    ],
  },
  {
    key: "system",
    labelKey: "admin.navGroups.system",
    items: [
      { href: "/admin/system", key: "system", labelKey: "admin.nav.system" },
      { href: "/admin/account", key: "account", labelKey: "admin.nav.account" },
    ],
  },
];

export const adminNavItems = adminNavGroups.flatMap((group) => group.items);

function normalizeAdminPath(pathname: string): string {
  const pathOnly = pathname.split(/[?#]/, 1)[0] || "/";
  if (pathOnly.length > 1 && pathOnly.endsWith("/")) return pathOnly.replace(/\/+$/g, "");
  return pathOnly;
}

function isAdminNavMatch(pathname: string, href: string): boolean {
  const normalizedPath = normalizeAdminPath(pathname);
  const normalizedHref = normalizeAdminPath(href);

  if (normalizedHref === "/admin") return normalizedPath === "/admin";
  return normalizedPath === normalizedHref || normalizedPath.startsWith(`${normalizedHref}/`);
}

export function matchAdminNavItem(pathname: string): AdminNavItem | null {
  const matches = adminNavItems
    .filter((item) => isAdminNavMatch(pathname, item.href))
    .sort((left, right) => right.href.length - left.href.length);
  return matches[0] ?? null;
}
