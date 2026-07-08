import Link from "next/link";

import {
  MobileDataCard,
  MobileDataField,
  Notice,
  PageHeader,
  ResponsiveDataView,
  StatusBadge,
} from "@/components/admin/primitives";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { listPosts } from "@/modules/content";
import { getT } from "@/modules/i18n/server";

export const dynamic = "force-dynamic";

const STATUS_KEYS: Record<string, string> = {
  draft: "admin.posts.draft",
  published: "admin.posts.published",
  archived: "admin.posts.archived",
};

const VISIBILITY_KEYS: Record<string, string> = {
  public: "admin.posts.public",
  login: "admin.posts.login",
  member: "admin.posts.member",
};

const STATUS_TONES: Record<string, "neutral" | "success" | "warning"> = {
  archived: "neutral",
  draft: "warning",
  published: "success",
};

const VISIBILITY_TONES: Record<string, "info" | "neutral" | "warning"> = {
  login: "warning",
  member: "neutral",
  public: "info",
};

export default async function AdminPostsPage() {
  const posts = await listPosts();
  const t = await getT();
  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button asChild>
            <Link href="/admin/posts/new">{t("admin.posts.new")}</Link>
          </Button>
        }
        description={t("admin.posts.description")}
        title={t("admin.posts.title")}
      />
      <ResponsiveDataView
        table={
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin.posts.titleColumn")}</TableHead>
                <TableHead>{t("admin.posts.visibility")}</TableHead>
                <TableHead>{t("admin.common.status")}</TableHead>
                <TableHead>{t("admin.posts.updatedAt")}</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {posts.map((post) => (
                <TableRow key={post.id}>
                  <TableCell className="max-w-96 whitespace-normal break-words font-medium">
                    {post.title}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={VISIBILITY_TONES[post.visibility]}>
                      {t(VISIBILITY_KEYS[post.visibility])}
                    </StatusBadge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={STATUS_TONES[post.status]}>
                      {t(STATUS_KEYS[post.status])}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(post.updatedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/admin/posts/${post.id}`}>{t("admin.common.edit")}</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        }
        cards={posts.map((post) => (
          <MobileDataCard
            key={post.id}
            title={post.title}
            actions={
              <Button size="sm" variant="outline" asChild>
                <Link href={`/admin/posts/${post.id}`}>{t("admin.common.edit")}</Link>
              </Button>
            }
          >
            <div className="flex flex-wrap gap-2">
              <StatusBadge tone={VISIBILITY_TONES[post.visibility]}>
                {t(VISIBILITY_KEYS[post.visibility])}
              </StatusBadge>
              <StatusBadge tone={STATUS_TONES[post.status]}>
                {t(STATUS_KEYS[post.status])}
              </StatusBadge>
            </div>
            <MobileDataField
              label={t("admin.posts.updatedAt")}
              valueClassName="text-muted-foreground"
            >
              {formatDateTime(post.updatedAt)}
            </MobileDataField>
          </MobileDataCard>
        ))}
      />
      {posts.length === 0 && <Notice>{t("admin.posts.empty")}</Notice>}
    </div>
  );
}
