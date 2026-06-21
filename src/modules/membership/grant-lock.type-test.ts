import { getDb } from "@/db";

import { acquireUserGrantLock } from "./index";

if (false) {
  // @ts-expect-error The advisory lock contract accepts an explicit transaction only.
  void acquireUserGrantLock(getDb(), "00000000-0000-0000-0000-000000000000");
}
