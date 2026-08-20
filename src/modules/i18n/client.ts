"use client";

import type { Messages } from "./messages/zh";
import { translateMessages } from "./runtime";

let activeMessages: Messages | null = null;

/** Install the effective catalog for imperative client helpers such as api(). */
export function installClientMessages(messages: Messages | null): void {
  activeMessages = messages;
}

export function translateClient(key: string, params?: Record<string, string | number>): string {
  return activeMessages ? translateMessages(activeMessages, key, params) : key;
}
