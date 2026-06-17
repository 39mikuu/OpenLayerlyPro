import { LockKeyhole } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { Translate } from "@/modules/i18n";
import type { PostVisibility } from "@/modules/theme/types";

export function PostVisibilityBadge({
  visibility,
  t,
  memberLabel,
}: {
  visibility: PostVisibility;
  t: Translate;
  memberLabel?: string;
}) {
  if (visibility === "member") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-pink-200 bg-pink-50 text-pink-700 dark:border-pink-900 dark:bg-pink-950/40 dark:text-pink-300"
      >
        <LockKeyhole className="size-3" />
        {memberLabel ?? t("postCard.member")}
      </Badge>
    );
  }

  if (visibility === "login") {
    return (
      <Badge variant="outline" className="gap-1">
        <LockKeyhole className="size-3" />
        {t("postCard.login")}
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className="font-medium">
      {t("postCard.public")}
    </Badge>
  );
}
