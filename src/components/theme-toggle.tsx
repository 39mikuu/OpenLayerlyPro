"use client";

import { useEffect, useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

/**
 * 明暗切换：本步仅 light/dark 两态。无 cookie 时默认跟随系统（由根布局内联脚本解析），
 * 用户切换后写显式 `theme_mode` cookie 并即时切 `.dark`。「恢复为 system」留后续。
 */
export function ThemeToggle() {
  const t = useT();
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    document.cookie = `theme_mode=${next ? "dark" : "light"}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      aria-label={t(dark ? "theme.toLight" : "theme.toDark")}
      suppressHydrationWarning
    >
      <span suppressHydrationWarning>{dark ? "☀️" : "🌙"}</span>
    </Button>
  );
}
