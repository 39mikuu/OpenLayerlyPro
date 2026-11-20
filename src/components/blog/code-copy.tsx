"use client";

import { useEffect, useRef } from "react";

export function CodeCopy({
  children,
  labels,
}: {
  children: React.ReactNode;
  labels: { copy: string; copied: string; copyFailed: string };
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const buttons: HTMLButtonElement[] = [];
    for (const pre of root.current?.querySelectorAll("pre") ?? []) {
      const code = pre.querySelector("code");
      if (!code) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "blog-code-copy";
      button.textContent = labels.copy;
      button.onclick = async () => {
        try {
          await navigator.clipboard.writeText(code.textContent ?? "");
          button.textContent = labels.copied;
        } catch {
          button.textContent = labels.copyFailed;
        }
      };
      button.setAttribute("aria-live", "polite");
      pre.before(button);
      buttons.push(button);
    }
    return () => buttons.forEach((button) => button.remove());
  }, [labels]);
  return <div ref={root}>{children}</div>;
}
