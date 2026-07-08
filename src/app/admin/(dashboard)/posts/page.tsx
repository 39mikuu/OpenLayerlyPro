import Link from "next/link";

import { Notice, PageHeader, StatusBadge } from "@/components/admin/primitives";
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
              <TableCell>{post.title}</TableCell>
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
              <TableCell>
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/admin/posts/${post.id}`}>{t("admin.common.edit")}</Link>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {posts.length === 0 && <Notice>{t("admin.posts.empty")}</Notice>}
    </div>
  );
}
