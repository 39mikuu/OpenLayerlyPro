import type { NextRequest } from "next/server";

type NeverEndingBodyRequest = {
  request: NextRequest;
  get pulls(): number;
  cleanup: () => void;
};

export function neverEndingBodyRequest(
  url: string,
  init: Omit<RequestInit, "body"> = {},
): NeverEndingBodyRequest {
  let pulls = 0;
  let resolveBlockedPull!: () => void;
  const blockedPull = new Promise<void>((resolve) => {
    resolveBlockedPull = resolve;
  });
  let cleanedUp = false;

  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulls += 1;
        return blockedPull;
      },
      cancel() {
        resolveBlockedPull();
      },
    },
    { highWaterMark: 0 },
  );

  const request = new Request(url, {
    ...init,
    method: init.method ?? "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" }) as NextRequest;

  return {
    request,
    get pulls() {
      return pulls;
    },
    cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      resolveBlockedPull();
      void body.cancel().catch(() => undefined);
    },
  };
}
