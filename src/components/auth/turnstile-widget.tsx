"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render: (
    el: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // 失败后移除残留 script 并清空缓存，允许重试重新注入
      script.remove();
      scriptPromise = null;
      reject(new Error("Turnstile 脚本加载失败"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export type TurnstileWidgetHandle = {
  /** 重置 widget，让用户重新获取 token */
  reset: () => void;
};

type TurnstileWidgetProps = {
  siteKey: string;
  /** token 获取成功传入 token，过期/出错传入 null */
  onToken: (token: string | null) => void;
};

export const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ siteKey, onToken }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetIdRef = useRef<string | null>(null);
    const onTokenRef = useRef(onToken);
    onTokenRef.current = onToken;
    const [loadFailed, setLoadFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useImperativeHandle(ref, () => ({
      reset() {
        if (widgetIdRef.current !== null && window.turnstile) {
          window.turnstile.reset(widgetIdRef.current);
        }
      },
    }));

    useEffect(() => {
      let cancelled = false;
      loadTurnstileScript()
        .then(() => {
          if (cancelled || !containerRef.current || !window.turnstile) return;
          widgetIdRef.current = window.turnstile.render(containerRef.current, {
            sitekey: siteKey,
            callback: (token) => onTokenRef.current(token),
            "expired-callback": () => onTokenRef.current(null),
            "error-callback": () => onTokenRef.current(null),
          });
        })
        .catch(() => {
          if (cancelled) return;
          setLoadFailed(true);
          onTokenRef.current(null);
        });
      return () => {
        cancelled = true;
        if (widgetIdRef.current !== null && window.turnstile) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }
      };
    }, [siteKey, attempt]);

    if (loadFailed) {
      return (
        <div className="space-y-2">
          <p className="text-xs text-destructive">人机验证加载失败，请检查网络后重试。</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setLoadFailed(false);
              setAttempt((n) => n + 1);
            }}
          >
            重新加载人机验证
          </Button>
        </div>
      );
    }

    return <div ref={containerRef} />;
  },
);
