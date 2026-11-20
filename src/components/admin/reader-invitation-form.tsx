"use client";

import { useActionState } from "react";

import { createInvitation } from "@/app/admin/(dashboard)/invitations/actions";
import type { getBlogCopy } from "@/modules/blog/copy";

export function ReaderInvitationForm({
  copy,
  emailLabel,
}: {
  copy: ReturnType<typeof getBlogCopy>;
  emailLabel: string;
}) {
  const [state, action, pending] = useActionState(createInvitation, {});
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <form action={action} className="space-y-3">
        <label className="block text-sm font-medium">
          {emailLabel}
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            className="mt-1 block w-full max-w-md rounded-md border bg-background p-2"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input name="send" type="checkbox" />
          {copy.sendInvite}
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {copy.createInvite}
        </button>
      </form>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.url && (
        <label className="block text-sm">
          {copy.inviteLink}
          <input
            readOnly
            value={state.url}
            aria-label={copy.inviteLink}
            className="mt-1 block w-full rounded-md border bg-background p-2"
          />
        </label>
      )}
      {(state.notice || state.url) && (
        <p role="status" className="text-sm text-muted-foreground">
          {state.notice ?? copy.inviteCreated}
        </p>
      )}
    </div>
  );
}
