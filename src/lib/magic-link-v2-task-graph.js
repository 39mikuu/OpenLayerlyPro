const ALLOWED_LOCALES = new Set(["zh", "en", "ja"]);
const DELIVERY_KEYS = new Set([
  "version",
  "deliveryProtocol",
  "tokenId",
  "encryptedToken",
  "locale",
]);
const INTAKE_KEYS = new Set(["version", "requestId"]);
const LEGACY_DELIVERY_KEYS = new Set(["version", "tokenId", "encryptedToken", "locale"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fail-closed graph check for a protocol-v2 delivery task. This is shared by
 * application maintenance and the source/bundled rollback command because a
 * database constraint cannot repair a historically corrupted task or ledger.
 */
export function isExactMagicLinkDeliveryV2Task(task, candidateId) {
  if (!isRecord(task) || typeof candidateId !== "string") return false;

  const queueClass = task.queueClass ?? task.queue_class;
  const payload = task.payloadJson ?? task.payload_json;
  if (
    task.kind !== "auth.magic_link_email" ||
    queueClass !== "auth_delivery_v2" ||
    !isRecord(payload) ||
    payload.version !== 1 ||
    payload.deliveryProtocol !== 2 ||
    payload.tokenId !== candidateId ||
    typeof payload.encryptedToken !== "string" ||
    payload.encryptedToken.length === 0
  ) {
    return false;
  }

  for (const key of Object.keys(payload)) {
    if (!DELIVERY_KEYS.has(key)) return false;
  }
  return (
    payload.locale === undefined ||
    (typeof payload.locale === "string" && ALLOWED_LOCALES.has(payload.locale))
  );
}

/**
 * Equivalent fail-closed graph check for an intake task. It deliberately
 * accepts neither a queue-class downgrade nor role/email-bearing extras.
 */
export function isExactMagicLinkIntakeTask(task, requestId) {
  if (!isRecord(task) || typeof requestId !== "string") return false;

  const queueClass = task.queueClass ?? task.queue_class;
  const payload = task.payloadJson ?? task.payload_json;
  if (
    task.kind !== "auth.magic_link_request" ||
    queueClass !== "auth_intake" ||
    !isRecord(payload) ||
    payload.version !== 1 ||
    payload.requestId !== requestId
  ) {
    return false;
  }
  return Object.keys(payload).every((key) => INTAKE_KEYS.has(key));
}

/**
 * Phase-A legacy tasks remain executable only on the transactional queue. A
 * malformed row is never silently downgraded from v2 into a legacy SMTP send.
 */
export function isExactLegacyMagicLinkDeliveryTask(task, tokenId) {
  if (!isRecord(task) || typeof tokenId !== "string") return false;

  const queueClass = task.queueClass ?? task.queue_class;
  const dedupeKey = task.dedupeKey ?? task.dedupe_key;
  const payload = task.payloadJson ?? task.payload_json;
  if (
    task.kind !== "auth.magic_link_email" ||
    queueClass !== "transactional" ||
    dedupeKey !== `auth-magic-link-email:${tokenId}` ||
    !isRecord(payload) ||
    payload.version !== 1 ||
    payload.tokenId !== tokenId ||
    typeof payload.encryptedToken !== "string" ||
    payload.encryptedToken.length === 0 ||
    Object.prototype.hasOwnProperty.call(payload, "deliveryProtocol")
  ) {
    return false;
  }
  if (!Object.keys(payload).every((key) => LEGACY_DELIVERY_KEYS.has(key))) return false;
  return (
    payload.locale === undefined ||
    (typeof payload.locale === "string" && ALLOWED_LOCALES.has(payload.locale))
  );
}
