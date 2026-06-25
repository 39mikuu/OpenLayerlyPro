import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique().notNull(),
  passwordHash: text("password_hash"),
  displayName: text("display_name"),
  role: text("role", { enum: ["admin", "member"] })
    .notNull()
    .default("member"),
  locale: text("locale", { enum: ["zh", "en", "ja"] })
    .notNull()
    .default("zh"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("sessions_token_hash_idx").on(table.tokenHash),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const loginCodes = pgTable(
  "login_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: createdAt(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("login_codes_email_created_idx").on(table.email, table.createdAt.desc()),
    index("login_codes_email_active_idx").on(table.email, table.expiresAt, table.usedAt),
  ],
);

export const siteSettings = pgTable("site_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").unique().notNull(),
  valueJson: jsonb("value_json").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// 加密配置存储（配置中心）。与明文公开的 site_settings 分表，避免密钥与公开设置混存。
// value_encrypted 为整组配置 JSON 的 AES-256-GCM 密文，key 为配置组名（如 "smtp"）。
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  valueEncrypted: text("value_encrypted").notNull(),
  updatedAt: updatedAt(),
});

export const membershipTiers = pgTable("membership_tiers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  description: text("description"),
  priceLabel: text("price_label").notNull(),
  priceAmountMinor: bigint("price_amount_minor", { mode: "number" }),
  currency: text("currency"),
  stripePriceId: text("stripe_price_id"),
  level: integer("level").notNull(),
  durationDays: integer("duration_days").notNull().default(31),
  purchaseEnabled: boolean("purchase_enabled").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tierId: uuid("tier_id")
      .notNull()
      .references(() => membershipTiers.id),
    source: text("source", {
      enum: ["manual", "payment_review", "payment_auto", "gift", "external"],
    }).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    note: text("note"),
    status: text("status", { enum: ["active", "suspended", "revoked"] })
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(0),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("memberships_user_active_idx").on(table.userId, table.startsAt, table.endsAt),
    index("memberships_tier_id_idx").on(table.tierId),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tierId: uuid("tier_id")
      .notNull()
      .references(() => membershipTiers.id),
    status: text("status", {
      enum: ["pending", "active", "past_due", "canceled", "expired"],
    }).notNull(),
    provider: text("provider"),
    providerSubscriptionRef: text("provider_subscription_ref"),
    providerCheckoutRef: text("provider_checkout_ref"),
    providerCustomerRef: text("provider_customer_ref"),
    providerPriceRef: text("provider_price_ref"),
    expectedAmountMinor: bigint("expected_amount_minor", { mode: "number" }),
    expectedCurrency: text("expected_currency"),
    quantity: integer("quantity"),
    currentPeriodEndsAt: timestamp("current_period_ends_at", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    statusEventAt: timestamp("status_event_at", { withTimezone: true }),
    checkoutClaimToken: text("checkout_claim_token"),
    checkoutClaimedAt: timestamp("checkout_claimed_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("subscriptions_user_status_idx").on(table.userId, table.status),
    index("subscriptions_reconcile_idx").on(table.status, table.updatedAt),
    uniqueIndex("subscriptions_provider_subscription_ref_unique")
      .on(table.provider, table.providerSubscriptionRef)
      .where(sql`${table.providerSubscriptionRef} is not null`),
    // subscriptions_one_nonterminal_per_identity is created by a hand-written
    // migration because drizzle-orm 0.45 cannot express PostgreSQL's
    // NULLS NOT DISTINCT unique-index clause.
  ],
);

export const paymentMethods = pgTable("payment_methods", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  qrFileId: uuid("qr_file_id"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const paymentRequests = pgTable(
  "payment_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tierId: uuid("tier_id")
      .notNull()
      .references(() => membershipTiers.id),
    paymentMethodId: uuid("payment_method_id"),
    status: text("status", {
      enum: ["pending_review", "pending_payment", "approved", "rejected", "cancelled", "reversed"],
    }).notNull(),
    flow: text("flow", { enum: ["manual", "auto"] })
      .notNull()
      .default("manual"),
    provider: text("provider"),
    providerRef: text("provider_ref"),
    providerEventId: text("provider_event_id"),
    providerPaymentRef: text("provider_payment_ref"),
    providerInvoiceRef: text("provider_invoice_ref"),
    reversalEventId: text("reversal_event_id"),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id),
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: text("currency"),
    grantedMembershipId: uuid("granted_membership_id").references(() => memberships.id),
    amountLabel: text("amount_label").notNull(),
    durationDays: integer("duration_days").notNull(),
    proofFileId: uuid("proof_file_id"),
    note: text("note"),
    reviewNote: text("review_note"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("payment_requests_user_created_idx").on(table.userId, table.createdAt.desc()),
    index("payment_requests_status_created_idx").on(table.status, table.createdAt),
    index("payment_requests_pending_user_tier_idx").on(table.userId, table.tierId, table.status),
    uniqueIndex("payment_requests_pending_user_tier_unique")
      .on(table.userId, table.tierId)
      .where(sql`${table.status} in ('pending_review', 'pending_payment')`),
    uniqueIndex("payment_requests_granted_membership_id_unique").on(table.grantedMembershipId),
    uniqueIndex("payment_requests_provider_event_id_unique").on(table.providerEventId),
    uniqueIndex("payment_requests_provider_payment_ref_unique")
      .on(table.provider, table.providerPaymentRef)
      .where(sql`${table.provider} is not null and ${table.providerPaymentRef} is not null`),
    uniqueIndex("payment_requests_provider_invoice_ref_unique")
      .on(table.provider, table.providerInvoiceRef)
      .where(sql`${table.providerInvoiceRef} is not null`),
    uniqueIndex("payment_requests_reversal_event_id_unique")
      .on(table.provider, table.reversalEventId)
      .where(sql`${table.provider} is not null and ${table.reversalEventId} is not null`),
    index("payment_requests_provider_ref_idx").on(table.providerRef),
    index("payment_requests_subscription_idx").on(table.subscriptionId),
  ],
);

export const paymentProviderEvents = pgTable(
  "payment_provider_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    objectRef: text("object_ref"),
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }).notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    status: text("status", {
      enum: ["received", "processing", "processed", "failed", "dead"],
    })
      .notNull()
      .default("received"),
    lockedBy: text("locked_by"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("payment_provider_events_provider_event_unique").on(
      table.provider,
      table.providerEventId,
    ),
    index("payment_provider_events_claim_idx").on(table.status, table.createdAt),
  ],
);

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    slug: text("slug").unique().notNull(),
    summary: text("summary"),
    body: text("body"),
    originalLocale: text("original_locale").notNull().default("zh"),
    coverFileId: uuid("cover_file_id"),
    visibility: text("visibility", { enum: ["public", "login", "member"] }).notNull(),
    requiredTierId: uuid("required_tier_id").references(() => membershipTiers.id),
    status: text("status", { enum: ["draft", "published", "archived"] }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    scheduleToken: uuid("schedule_token"),
    contentUpdatedAt: timestamp("content_updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("posts_status_published_idx").on(table.status, table.publishedAt.desc()),
    index("posts_status_scheduled_idx").on(table.status, table.scheduledAt),
    check(
      "posts_schedule_pair_check",
      sql`(${table.scheduledAt} is null) = (${table.scheduleToken} is null)`,
    ),
    check(
      "posts_schedule_draft_only_check",
      sql`${table.status} = 'draft' or (${table.scheduledAt} is null and ${table.scheduleToken} is null)`,
    ),
    check(
      "posts_published_at_check",
      sql`${table.status} <> 'published' or ${table.publishedAt} is not null`,
    ),
  ],
);

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const postCategories = pgTable(
  "post_categories",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.categoryId] }),
    index("post_categories_category_idx").on(table.categoryId),
  ],
);

export const postTags = pgTable(
  "post_tags",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.tagId] }),
    index("post_tags_tag_idx").on(table.tagId),
  ],
);

export const postTranslations = pgTable(
  "post_translations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    body: text("body"),
    status: text("status", { enum: ["draft", "published", "archived"] })
      .notNull()
      .default("draft"),
    source: text("source", { enum: ["manual", "machine"] })
      .notNull()
      .default("manual"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("post_translations_one_published_per_locale")
      .on(table.postId, table.locale)
      .where(sql`${table.status} = 'published'`),
    index("post_translations_lookup_idx").on(table.postId, table.locale, table.status),
  ],
);

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  storageDriver: text("storage_driver", { enum: ["local", "s3"] }).notNull(),
  bucket: text("bucket"),
  objectKey: text("object_key").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256"),
  width: integer("width"),
  height: integer("height"),
  purpose: text("purpose", {
    enum: [
      "artist_avatar",
      "payment_qr",
      "payment_proof",
      "content_image",
      "content_attachment",
      "cover",
      "thumbnail",
    ],
  }).notNull(),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const postFiles = pgTable(
  "post_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["cover", "image", "attachment", "preview", "thumbnail", "inline"],
    }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    index("post_files_post_sort_idx").on(table.postId, table.sortOrder),
    index("post_files_file_id_idx").on(table.fileId),
  ],
);

export const downloadLogs = pgTable("download_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  postId: uuid("post_id"),
  fileId: uuid("file_id").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  storageDriver: text("storage_driver").notNull(),
  createdAt: createdAt(),
});

export const appEvents = pgTable("app_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  payloadJson: jsonb("payload_json"),
  createdAt: createdAt(),
});

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    actorType: text("actor_type", { enum: ["admin", "user", "system"] }).notNull(),
    actorId: uuid("actor_id"),
    reason: text("reason"),
    beforeJson: jsonb("before_json"),
    afterJson: jsonb("after_json"),
    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_events_entity_idx").on(table.entityType, table.entityId, table.createdAt.desc()),
    index("audit_events_correlation_idx").on(table.correlationId),
    index("audit_events_causation_idx").on(table.causationId),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key"),
    payloadJson: jsonb("payload_json").notNull(),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    status: text("status", {
      enum: ["pending", "processing", "succeeded", "failed", "dead"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("tasks_dedupe_key_unique").on(table.dedupeKey),
    index("tasks_claim_idx").on(table.status, table.runAfter),
  ],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type LoginCode = typeof loginCodes.$inferSelect;
export type SiteSetting = typeof siteSettings.$inferSelect;
export type MembershipTier = typeof membershipTiers.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type PaymentRequest = typeof paymentRequests.$inferSelect;
export type PaymentProviderEvent = typeof paymentProviderEvents.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type PostCategory = typeof postCategories.$inferSelect;
export type PostTag = typeof postTags.$inferSelect;
export type PostTranslation = typeof postTranslations.$inferSelect;
export type FileRecord = typeof files.$inferSelect;
export type PostFile = typeof postFiles.$inferSelect;
export type DownloadLog = typeof downloadLogs.$inferSelect;
export type AppEvent = typeof appEvents.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Task = typeof tasks.$inferSelect;
