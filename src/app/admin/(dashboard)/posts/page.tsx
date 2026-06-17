import Link from "next/link";

import { Badge } from "@/components/ui/badge";
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

export default async function AdminPostsPage() {
  const posts = await listPosts();
  const t = await getT();
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t("admin.posts.title")}</h1>
        <Button asChild>
          <Link href="/admin/posts/new">{t("admin.posts.new")}</Link>
        </Button>
      </div>
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
                <Badge variant="secondary">{t(VISIBILITY_KEYS[post.visibility])}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant={post.status === "published" ? "default" : "outline"}>
                  {t(STATUS_KEYS[post.status])}
                </Badge>
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
      {posts.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("admin.posts.empty")}</p>
      )}
    </div>
  );
}
